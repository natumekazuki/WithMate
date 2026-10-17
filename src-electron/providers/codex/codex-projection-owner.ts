import { createProviderAgentRuntimeBindingRedactor, type ProviderAgentRuntimeBindingRedactor } from "../provider-agent-runtime-binding.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT, stringifyBoundedProviderRawItems } from "../../session/provider-payload-limits.js";
import { buildCodexStableRawItems, buildCodexProviderMetadata } from "./codex-event-projection.js";
import { applyCodexTurnEvent, collectCodexAssistantResponseFromItems, collectCodexQuestionRanges, createCodexTurnStreamState, getLiveCodexAssistantPreview, getLiveCodexReasoningPreview, type CodexNativeNotification } from "./codex-turn-events.js";
import type { CodexProjectionStart, CodexProjectionProgress, CodexProjectionFinal, CodexProjectionEvent } from "./codex-projection-protocol.js";
import type { BoundedProviderRawItem } from "../../session/provider-payload-limits.js";

/** Owns native items and sanitized projections inside the shared projection Worker. */
export class CodexProjectionOwner {
  private readonly state;
  private readonly redactor: ProviderAgentRuntimeBindingRedactor;
  private liveRevision = -1;
  private assistantSource = "";
  private assistantText = "";
  private reasoningSource = "";
  private reasoningText = "";

  constructor(private readonly input: CodexProjectionStart) {
    this.state = createCodexTurnStreamState(input.threadId);
    this.state.turnId = input.turnId;
    this.redactor = createProviderAgentRuntimeBindingRedactor(input.binding, [input.apiKey]);
  }

  private assistantPreview(): string {
    const assistant = getLiveCodexAssistantPreview(this.state);
    if (assistant !== this.assistantSource) {
      this.assistantSource = assistant;
      this.assistantText = this.redactor.sanitizeText(assistant);
    }
    return this.assistantText;
  }

  private frame(steps: CodexProjectionProgress["state"]["steps"]): CodexProjectionProgress["state"] {
    const assistantText = this.assistantPreview();
    const reasoning = getLiveCodexReasoningPreview(this.state);
    if (reasoning !== this.reasoningSource) {
      this.reasoningSource = reasoning;
      this.reasoningText = this.redactor.sanitizeText(reasoning);
    }
    return {
      sessionId: this.input.sessionId, threadId: this.input.threadId, turnId: this.input.turnId,
      assistantText, reasoningText: this.reasoningText, steps,
      assistantQuestionRanges: collectCodexQuestionRanges(this.state.items.values(), this.assistantSource, this.redactor.sanitizeText, PROVIDER_TEXT_PREVIEW_LIMIT),
      backgroundTasks: [], usage: this.state.usage,
      errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage),
      approvalRequest: null, elicitationRequest: null,
    };
  }

  apply(event: CodexNativeNotification): CodexProjectionEvent {
    const revision = this.state.revision;
    const errorMessage = this.state.streamErrorMessage;
    if (event.params && typeof event.params === "object") {
      const params = event.params as Record<string, unknown>;
      if (event.method === "item/started" || event.method === "item/completed") {
        event = { ...event, params: { ...params, item: this.sanitizeMcpResult(params.item) } };
      } else if (event.method === "turn/completed" && params.turn && typeof params.turn === "object") {
        const turn = params.turn as Record<string, unknown>;
        if (Array.isArray(turn.items)) {
          event = { ...event, params: { ...params, turn: { ...turn, items: turn.items.map(item => this.sanitizeMcpResult(item)) } } };
        }
      }
    }
    applyCodexTurnEvent(this.state, event);
    return {
      changed: this.input.progress && revision !== this.state.revision,
      ...(this.input.progress && errorMessage !== this.state.streamErrorMessage
        ? { errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage) } : {}),
    };
  }

  private sanitizeMcpResult(value: unknown): unknown {
    if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== "mcpToolCall") return value;
    const item = value as Record<string, unknown>;
    return { ...item, result: this.redactor.sanitize(item.result), error: this.redactor.sanitize(item.error) };
  }

  live(inputAvailable: boolean, force = false): CodexProjectionProgress | null {
    if (!this.input.progress || !force && this.liveRevision === this.state.revision) return null;
    this.liveRevision = this.state.revision;
    const steps = this.state.liveSteps.takeProgress(this.redactor, false);
    return {
      state: { ...this.frame(steps.snapshot), inputAvailable },
      changes: { snapshot: false, steps: steps.changes, backgroundTasks: { upserts: [], removes: [] } },
    };
  }

  questionPosition(): number {
    const { assistantText } = collectCodexAssistantResponseFromItems(this.state.items.values());
    return this.redactor.sanitizeText(assistantText).length;
  }

  finish(diagnostics: BoundedProviderRawItem[]): CodexProjectionFinal {
    const items = this.redactor.sanitize([...this.state.items.values()]);
    const response = collectCodexAssistantResponseFromItems(items);
    return {
      items, ...response,
      ...(this.input.diagnosticTrace ? { rawItemsJson: stringifyBoundedProviderRawItems([...this.redactor.sanitize(diagnostics), ...buildCodexStableRawItems(items)]) } : {}),
      providerMetadata: buildCodexProviderMetadata(items), usage: this.state.usage,
      terminalStatus: this.state.terminalStatus, errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage),
    };
  }

  sanitizeError(error: unknown): string {
    return this.redactor.sanitizeText(error instanceof Error ? error.message : String(error));
  }
}
