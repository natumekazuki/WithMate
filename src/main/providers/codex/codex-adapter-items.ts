import { snapshotMessageContentBlocks, type TextContentBlock } from "../../../shared/message-content.js";
import {
  CODEX_ADAPTER_LIMITS,
  type CodexAdapterDiagnostic,
  type CodexAdapterEvent,
  type CodexAdapterOutput,
  type CodexAdapterOutputPayload,
} from "./codex-adapter-contract.js";
import type { CodexValidatedItem } from "./codex-adapter-validation.js";

export type CodexItemMapperResult = Readonly<{
  events: readonly CodexAdapterEvent[];
  fatal: boolean;
}>;

export type CodexTurnContentResult = CodexItemMapperResult &
  Readonly<{
    finalAssistantMessage: Readonly<{ contentBlocks: readonly TextContentBlock[] }> | null;
    contentFailure: Readonly<{ code: "size_limit" | "invalid_content" }> | null;
  }>;

export type CodexItemMapperSnapshot = Readonly<{
  failed: boolean;
  trackedThreads: number;
  trackedTurns: number;
  trackedItems: number;
  retainedTextBytes: number;
}>;

type TurnState = {
  cliVersion: string;
  model: string;
  items: Map<string, ItemState>;
  completedAgents: CompletedAgent[];
  draftTextBytes: number;
  outputTextBytes: number;
  retainedTextBytes: number;
  contentFailure: "size_limit" | "invalid_content" | undefined;
};

type ItemState = {
  itemType: string;
  classification: CodexValidatedItem["classification"];
  completed: boolean;
  deltaSeen: boolean;
  draftOverflow: boolean;
  draft: string;
  draftBytes: number;
};

type CompletedAgent = {
  itemId: string;
  phase: "commentary" | "final_answer" | null;
  text: string | null;
  originalByteLength: number;
  omitted: boolean;
};

type TerminalStatus = "completed" | "failed" | "interrupted";

export class CodexAdapterItemMapper {
  readonly #threads = new Map<string, Map<string, TurnState>>();
  #trackedTurnCount = 0;
  #trackedItemCount = 0;
  #retainedTextBytes = 0;
  #failed = false;

  beginTurn(threadId: string, turnId: string, cliVersion: string, model: string): CodexItemMapperResult {
    if (this.#failed) return failedResult();
    let turns = this.#threads.get(threadId);
    if (turns === undefined) {
      if (this.#threads.size >= CODEX_ADAPTER_LIMITS.maxTrackedThreads) return this.#failResourceLimit();
      turns = new Map();
      this.#threads.set(threadId, turns);
    }
    const existing = turns.get(turnId);
    if (existing !== undefined) {
      return existing.cliVersion === cliVersion && existing.model === model
        ? diagnosticResult("duplicate_event", "A duplicate Turn item context was ignored.")
        : diagnosticResult("identity_mismatch", "A conflicting Turn item context was ignored.");
    }
    if (this.#trackedTurnCount >= CODEX_ADAPTER_LIMITS.maxTrackedTurns) return this.#failResourceLimit();
    turns.set(turnId, {
      cliVersion,
      model,
      items: new Map(),
      completedAgents: [],
      draftTextBytes: 0,
      outputTextBytes: 0,
      retainedTextBytes: 0,
      contentFailure: undefined,
    });
    this.#trackedTurnCount += 1;
    return emptyResult();
  }

  acceptItemStarted(threadId: string, turnId: string, item: CodexValidatedItem): CodexItemMapperResult {
    if (this.#failed) return failedResult();
    const turn = this.#threads.get(threadId)?.get(turnId);
    if (turn === undefined) {
      return diagnosticResult("out_of_order_event", "An item start for an unknown Turn was ignored.");
    }
    if (turn.items.has(item.id)) {
      return diagnosticResult("duplicate_event", "A duplicate item start was ignored.");
    }
    if (this.#trackedItemCount >= CODEX_ADAPTER_LIMITS.maxTrackedItems) return this.#failResourceLimit();
    turn.items.set(item.id, {
      itemType: itemType(item),
      classification: item.classification,
      completed: false,
      deltaSeen: false,
      draftOverflow: false,
      draft: "",
      draftBytes: 0,
    });
    this.#trackedItemCount += 1;
    return emptyResult();
  }

  acceptAgentDelta(threadId: string, turnId: string, itemId: string, delta: string): CodexItemMapperResult {
    if (this.#failed) return failedResult();
    const turn = this.#threads.get(threadId)?.get(turnId);
    const item = turn?.items.get(itemId);
    if (turn === undefined || item === undefined) {
      return diagnosticResult("out_of_order_event", "An agent delta before item start was ignored.");
    }
    if (item.completed) {
      return diagnosticResult("out_of_order_event", "An agent delta after item completion was ignored.");
    }
    if (item.classification !== "agentMessage") {
      return diagnosticResult("identity_mismatch", "An agent delta for another item type was ignored.");
    }
    if (item.draftOverflow) return emptyResult();
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    if (
      item.draftBytes + deltaBytes > CODEX_ADAPTER_LIMITS.maxItemTextBytes ||
      turn.draftTextBytes + turn.outputTextBytes + deltaBytes > CODEX_ADAPTER_LIMITS.maxTurnTextBytes
    ) {
      this.#releaseDraft(turn, item);
      item.draftOverflow = true;
      item.deltaSeen = true;
      return diagnosticResult("resource_limit", "An agent draft exceeded its bounded text scope.");
    }
    if (this.#retainedTextBytes + deltaBytes > CODEX_ADAPTER_LIMITS.maxConnectionTextBytes) {
      return this.#failResourceLimit();
    }
    item.deltaSeen = true;
    item.draft += delta;
    item.draftBytes += deltaBytes;
    turn.draftTextBytes += deltaBytes;
    turn.retainedTextBytes += deltaBytes;
    this.#retainedTextBytes += deltaBytes;
    return emptyResult();
  }

  acceptItemCompleted(threadId: string, turnId: string, item: CodexValidatedItem): CodexItemMapperResult {
    if (this.#failed) return failedResult();
    const turn = this.#threads.get(threadId)?.get(turnId);
    if (turn === undefined) {
      return diagnosticResult("out_of_order_event", "An item completion for an unknown Turn was ignored.");
    }
    const state = turn.items.get(item.id);
    if (state === undefined) {
      return diagnosticResult("out_of_order_event", "An item completion before item start was ignored.");
    }
    if (state.completed) {
      return diagnosticResult("duplicate_event", "A duplicate item completion was ignored.");
    }
    if (state.classification !== item.classification || state.itemType !== itemType(item)) {
      return diagnosticResult("identity_mismatch", "An item completion changed the tracked item identity.");
    }

    const events: CodexAdapterEvent[] = [];
    if (item.classification === "agentMessage") {
      if (!state.draftOverflow && state.deltaSeen && state.draft !== item.text) {
        events.push(diagnosticEvent("draft_mismatch", "Completed agent text replaced a mismatched draft."));
      }
      const completedBytes = Buffer.byteLength(item.text, "utf8");
      const connectionAfterDraft = this.#retainedTextBytes - state.draftBytes;
      const retainCandidate = item.phase !== "commentary" && item.text.length > 0;
      const exceedsTurnLimit = turn.outputTextBytes + completedBytes > CODEX_ADAPTER_LIMITS.maxTurnTextBytes;
      this.#releaseDraft(turn, state);
      state.completed = true;
      if (item.phase === "commentary") {
        events.push(
          ...this.#boundedAssistantOutputEvents(
            turn,
            threadId,
            turnId,
            item.id,
            assistantOutput("agent_commentary", item.text, "complete"),
          ),
        );
      } else if (exceedsTurnLimit) {
        state.draftOverflow = true;
        turn.contentFailure = "size_limit";
        this.#discardCandidateTexts(turn);
        turn.completedAgents.push({
          itemId: item.id,
          phase: item.phase,
          text: null,
          originalByteLength: completedBytes,
          omitted: true,
        });
        events.push(diagnosticEvent("resource_limit", "Completed assistant content exceeded the Turn text limit."));
      } else {
        if (retainCandidate && connectionAfterDraft + completedBytes > CODEX_ADAPTER_LIMITS.maxConnectionTextBytes) {
          return this.#failResourceLimit(events);
        }
        if (retainCandidate) {
          turn.outputTextBytes += completedBytes;
          turn.retainedTextBytes += completedBytes;
          this.#retainedTextBytes += completedBytes;
        }
        turn.completedAgents.push({
          itemId: item.id,
          phase: item.phase,
          text: retainCandidate ? item.text : null,
          originalByteLength: completedBytes,
          omitted: false,
        });
      }
      return results(events);
    }

    this.#releaseDraft(turn, state);
    state.completed = true;
    switch (item.classification) {
      case "plan":
        events.push(
          ...this.#boundedAssistantOutputEvents(
            turn,
            threadId,
            turnId,
            item.id,
            assistantOutput("plan", item.text, "complete"),
          ),
        );
        break;
      case "reasoning": {
        const reasoning = [...item.summary, ...item.content].join("\n");
        events.push(
          ...this.#boundedAssistantOutputEvents(
            turn,
            threadId,
            turnId,
            item.id,
            assistantOutput("reasoning", reasoning, "complete"),
          ),
        );
        break;
      }
      case "operation":
        events.push(itemOutputEvent(threadId, turnId, item.id, operationOutput(item.itemType, item.status)));
        break;
      case "unsupported":
        events.push(...this.#unsupportedItemEvents(threadId, turnId, item).events);
        break;
      case "userMessage":
        break;
    }
    return results(events);
  }

  completeTurn(threadId: string, turnId: string, status: TerminalStatus): CodexTurnContentResult {
    if (this.#failed) return failedTurnResult();
    const turn = this.#threads.get(threadId)?.get(turnId);
    if (turn === undefined) {
      return Object.freeze({
        ...diagnosticResult("out_of_order_event", "Assistant content for an unknown Turn was ignored."),
        finalAssistantMessage: null,
        contentFailure: null,
      });
    }

    const events: CodexAdapterEvent[] = [];
    let finalAssistantMessage: Readonly<{ contentBlocks: readonly TextContentBlock[] }> | null = null;
    let contentFailure: Readonly<{ code: "size_limit" | "invalid_content" }> | null =
      turn.contentFailure === undefined ? null : Object.freeze({ code: turn.contentFailure });
    const eligibleAgents = turn.completedAgents.filter((candidate) => candidate.text !== null || candidate.omitted);
    const explicit = eligibleAgents.filter(
      (candidate) => candidate.phase === "final_answer" && (candidate.text !== null || candidate.omitted),
    );
    const unknown = eligibleAgents.filter(
      (candidate) => candidate.phase === null && (candidate.text !== null || candidate.omitted),
    );

    if (status === "completed" && contentFailure === null) {
      const finalCandidates = explicit.length > 0 ? explicit : unknown.slice(-1);
      const detailCandidates = explicit.length > 0 ? unknown : unknown.slice(0, -1);
      for (const candidate of detailCandidates) {
        events.push(candidateDetailEvent(threadId, turnId, candidate, "complete"));
      }
      const blocks = finalCandidates.flatMap((candidate) =>
        candidate.text === null ? [] : [{ type: "text" as const, text: candidate.text }],
      );
      if (blocks.length > 0) {
        const snapshot = snapshotMessageContentBlocks(blocks);
        if (snapshot === undefined) {
          contentFailure = Object.freeze({ code: "size_limit" });
          for (const candidate of finalCandidates) {
            events.push(
              candidateDetailEvent(threadId, turnId, { ...candidate, text: null, omitted: true }, "complete"),
            );
          }
        } else {
          if (explicit.length === 0) {
            events.push(
              diagnosticEvent(
                "phase_fallback",
                "A phase-unknown assistant item supplied the successful final message.",
                { cliVersion: turn.cliVersion, model: turn.model },
              ),
            );
          }
          finalAssistantMessage = Object.freeze({ contentBlocks: snapshot });
        }
      }
    } else {
      const completionState = status === "completed" ? "complete" : "partial";
      for (const candidate of eligibleAgents) {
        events.push(candidateDetailEvent(threadId, turnId, candidate, completionState));
      }
    }

    this.#releaseTurn(threadId, turnId, turn);
    return Object.freeze({
      events: Object.freeze(events),
      fatal: false,
      finalAssistantMessage,
      contentFailure,
    });
  }

  snapshot(): CodexItemMapperSnapshot {
    return Object.freeze({
      failed: this.#failed,
      trackedThreads: this.#threads.size,
      trackedTurns: this.#trackedTurnCount,
      trackedItems: this.#trackedItemCount,
      retainedTextBytes: this.#retainedTextBytes,
    });
  }

  release(): void {
    this.#threads.clear();
    this.#trackedTurnCount = 0;
    this.#trackedItemCount = 0;
    this.#retainedTextBytes = 0;
    this.#failed = true;
  }

  #releaseDraft(turn: TurnState, item: ItemState): void {
    turn.draftTextBytes -= item.draftBytes;
    turn.retainedTextBytes -= item.draftBytes;
    this.#retainedTextBytes -= item.draftBytes;
    item.draft = "";
    item.draftBytes = 0;
  }

  #discardCandidateTexts(turn: TurnState): void {
    for (const candidate of turn.completedAgents) {
      if (candidate.text === null) continue;
      turn.retainedTextBytes -= candidate.originalByteLength;
      this.#retainedTextBytes -= candidate.originalByteLength;
      candidate.text = null;
      candidate.omitted = true;
    }
  }

  #boundedAssistantOutputEvents(
    turn: TurnState,
    threadId: string,
    turnId: string,
    itemId: string,
    output: CodexAdapterOutput,
  ): readonly CodexAdapterEvent[] {
    if (output.payload.kind !== "text") return [itemOutputEvent(threadId, turnId, itemId, output)];
    const textBytes = output.payload.originalByteLength;
    if (turn.outputTextBytes + textBytes > CODEX_ADAPTER_LIMITS.maxTurnTextBytes) {
      return [
        itemOutputEvent(threadId, turnId, itemId, omitTextOutput(output)),
        diagnosticEvent("resource_limit", "Completed assistant detail exceeded the Turn text limit."),
      ];
    }
    turn.outputTextBytes += textBytes;
    return [itemOutputEvent(threadId, turnId, itemId, output)];
  }

  #releaseTurn(threadId: string, turnId: string, turn: TurnState): void {
    this.#retainedTextBytes -= turn.retainedTextBytes;
    this.#trackedItemCount -= turn.items.size;
    this.#trackedTurnCount -= 1;
    const turns = this.#threads.get(threadId);
    turns?.delete(turnId);
    if (turns?.size === 0) this.#threads.delete(threadId);
  }

  #unsupportedItemEvents(
    threadId: string,
    turnId: string,
    item: Extract<CodexValidatedItem, { classification: "unsupported" }>,
  ): CodexItemMapperResult {
    return results([
      itemOutputEvent(threadId, turnId, item.id, providerMetadataOutput(item.itemType)),
      diagnosticEvent("unknown_item", "An unsupported Codex item was retained as bounded metadata.", {
        itemType: item.itemType,
        correlation: { threadId, turnId, itemId: item.id },
      }),
    ]);
  }

  #failResourceLimit(prefix: readonly CodexAdapterEvent[] = []): CodexItemMapperResult {
    this.#failed = true;
    return Object.freeze({
      events: Object.freeze([
        ...prefix,
        diagnosticEvent("resource_limit", "A Codex item resource limit was reached."),
        Object.freeze({ kind: "connection_failure", code: "adapter_resource_limit" }),
      ]),
      fatal: true,
    });
  }
}

function itemType(item: CodexValidatedItem): string {
  switch (item.classification) {
    case "agentMessage":
      return "agentMessage";
    case "plan":
      return "plan";
    case "reasoning":
      return "reasoning";
    case "operation":
      return item.itemType;
    case "userMessage":
      return "userMessage";
    case "unsupported":
      return item.itemType;
  }
}

function assistantOutput(
  kind: string,
  text: string,
  completionState: CodexAdapterOutput["completionState"],
): CodexAdapterOutput {
  return Object.freeze({
    category: "assistant_detail",
    kind,
    summary: "Assistant detail completed.",
    completionState,
    payload: textPayload(text),
  });
}

function operationOutput(itemTypeValue: string, status: string): CodexAdapterOutput {
  return Object.freeze({
    category: "operation",
    kind: itemTypeValue,
    summary: `Codex operation ${status}.`,
    completionState: status === "inProgress" ? "partial" : "complete",
    payload: Object.freeze({ kind: "none", redaction: "not_required" }),
  });
}

function providerMetadataOutput(itemTypeValue: string): CodexAdapterOutput {
  return Object.freeze({
    category: "provider_metadata",
    kind: itemTypeValue,
    summary: "Unsupported Codex item metadata was observed.",
    completionState: "complete",
    payload: Object.freeze({ kind: "none", redaction: "not_required" }),
  });
}

function textPayload(text: string): CodexAdapterOutputPayload {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes <= CODEX_ADAPTER_LIMITS.maxItemTextBytes
    ? Object.freeze({ kind: "text", text, originalByteLength: bytes, redaction: "undetermined" })
    : Object.freeze({ kind: "omitted", reason: "size_limit", originalByteLength: bytes, redaction: "undetermined" });
}

function omitTextOutput(output: CodexAdapterOutput): CodexAdapterOutput {
  if (output.payload.kind !== "text") return output;
  return Object.freeze({
    ...output,
    payload: Object.freeze({
      kind: "omitted",
      reason: "size_limit",
      originalByteLength: output.payload.originalByteLength,
      redaction: output.payload.redaction,
    }),
  });
}

function candidateDetailEvent(
  threadId: string,
  turnId: string,
  candidate: CompletedAgent,
  completionState: CodexAdapterOutput["completionState"],
): CodexAdapterEvent {
  const output =
    candidate.text === null || candidate.omitted
      ? Object.freeze({
          category: "assistant_detail" as const,
          kind: candidate.phase === "final_answer" ? "agent_final_candidate" : "agent_phase_unknown",
          summary: "Assistant candidate detail was omitted.",
          completionState,
          payload: Object.freeze({
            kind: "omitted" as const,
            reason: "size_limit" as const,
            originalByteLength: candidate.originalByteLength,
            redaction: "undetermined" as const,
          }),
        })
      : assistantOutput(
          candidate.phase === "final_answer" ? "agent_final_candidate" : "agent_phase_unknown",
          candidate.text,
          completionState,
        );
  return itemOutputEvent(threadId, turnId, candidate.itemId, output);
}

function itemOutputEvent(
  threadId: string,
  turnId: string,
  itemId: string,
  output: CodexAdapterOutput,
): CodexAdapterEvent {
  return Object.freeze({ kind: "item_output", threadId, turnId, itemId, output });
}

function diagnosticEvent(
  code: CodexAdapterDiagnostic["code"],
  summary: string,
  details: Readonly<{
    itemType?: string;
    cliVersion?: string;
    model?: string;
    correlation?: Readonly<{ threadId?: string; turnId?: string; itemId?: string }>;
  }> = {},
): CodexAdapterEvent {
  return Object.freeze({
    kind: "diagnostic",
    diagnostic: Object.freeze({ code, summary, ...details, redaction: "not_required" }),
  });
}

function diagnosticResult(
  code: CodexAdapterDiagnostic["code"],
  summary: string,
  itemTypeValue?: string,
): CodexItemMapperResult {
  return results([diagnosticEvent(code, summary, itemTypeValue === undefined ? {} : { itemType: itemTypeValue })]);
}

function results(events: readonly CodexAdapterEvent[]): CodexItemMapperResult {
  return Object.freeze({ events: Object.freeze([...events]), fatal: false });
}

function emptyResult(): CodexItemMapperResult {
  return Object.freeze({ events: Object.freeze([]), fatal: false });
}

function failedResult(): CodexItemMapperResult {
  return Object.freeze({ events: Object.freeze([]), fatal: true });
}

function failedTurnResult(): CodexTurnContentResult {
  return Object.freeze({
    events: Object.freeze([]),
    fatal: true,
    finalAssistantMessage: null,
    contentFailure: null,
  });
}
