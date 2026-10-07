import type {
  ProviderUsage,
  LiveRunStep,
} from "../../../src-shared/session/runtime-state.js";
import {
  PROVIDER_TEXT_PREVIEW_LIMIT,
  toProviderTextPreview,
  stringifyBoundedProviderValue,
} from "../../session/provider-payload-limits.js";
import { ProviderProgressMap } from "../provider-progress.js";

// The fields consumed here follow Codex App Server 0.159.0's ThreadItem schema.
export type CodexFileChange = {
  path: string;
  kind: { type: "add" | "delete" | "update"; move_path?: string | null };
  diff: string;
};
export type CodexTurnItem =
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "plan"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      aggregatedOutput: string | null;
      aggregatedOutputOriginalLength?: number;
      exitCode: number | null;
      status: string;
    }
  | {
      type: "fileChange";
      id: string;
      changes: CodexFileChange[];
      status: string;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      result: { structuredContent: unknown; content?: unknown[] } | null;
      error: { message: string } | null;
      status: string;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      agentsStates: unknown;
      status: string;
    }
  | { type: "webSearch"; id: string; query?: string; action?: unknown }
  | { type: "userMessage"; id: string; content: unknown[] };
export type CodexNativeNotification = { method: string; params?: unknown };
export type CodexTurnStreamState = {
  revision: number;
  items: Map<string, CodexTurnItem>;
  liveSteps: ProviderProgressMap<LiveRunStep>;
  threadId: string | null;
  turnId: string | null;
  reasoningText: string;
  usage: ProviderUsage | null;
  usageBaseline: ProviderUsage | null;
  streamErrorMessage: string;
  turnCompleted: boolean;
  terminalStatus: string | null;
};

class OrderedItemText {
  private readonly entries = new Map<string, { order: number; text: string }>();
  private readonly ordered: { order: number; text: string }[] = [];
  private orderChanged = false;
  private textLength = 0;
  private nonEmptyCount = 0;
  private fullText: string | undefined = "";
  private previewText: string | undefined = "";

  set(id: string, order: number, text: string): boolean {
    let entry = this.entries.get(id);
    if (entry?.text === text || (!entry && !text)) return false;
    if (!entry) {
      entry = { order, text: "" };
      this.entries.set(id, entry);
      const last = this.ordered.at(-1);
      if (last && last.order > order) this.orderChanged = true;
      this.ordered.push(entry);
    }
    this.textLength += text.length - entry.text.length;
    this.nonEmptyCount += Number(Boolean(text)) - Number(Boolean(entry.text));
    entry.text = text;
    this.fullText = undefined;
    this.previewText = undefined;
    return true;
  }

  full(): string {
    this.ensureOrder();
    return this.fullText ??= this.ordered.map((entry) => entry.text).filter(Boolean).join("\n\n");
  }

  private ensureOrder(): void {
    if (!this.orderChanged) return;
    this.ordered.sort((left, right) => left.order - right.order);
    this.orderChanged = false;
  }

  preview(): string {
    if (this.previewText !== undefined) return this.previewText;
    this.ensureOrder();
    const originalLength = this.textLength + Math.max(0, this.nonEmptyCount - 1) * 2;
    let prefix = "";
    let hasText = false;
    for (const entry of this.ordered) {
      if (!entry.text) continue;
      if (hasText) prefix += "\n\n".slice(0, PROVIDER_TEXT_PREVIEW_LIMIT - prefix.length);
      prefix += entry.text.slice(0, PROVIDER_TEXT_PREVIEW_LIMIT - prefix.length);
      hasText = true;
      if (prefix.length === PROVIDER_TEXT_PREVIEW_LIMIT) break;
    }
    this.previewText = originalLength > PROVIDER_TEXT_PREVIEW_LIMIT
      ? `${prefix}\n...[truncated ${originalLength - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${originalLength}]`
      : prefix;
    return this.previewText;
  }
}

const textCaches = new WeakMap<CodexTurnStreamState, {
  assistant: OrderedItemText;
  reasoning: OrderedItemText;
  order: Map<string, number>;
}>();

export function collectCodexAssistantResponseFromItems(
  items: Iterable<CodexTurnItem>,
): { assistantText: string; lastNonEmptyAssistantMessageText: string } {
  const parts = Array.from(items)
    .filter(
      (item): item is Extract<CodexTurnItem, { type: "agentMessage" }> =>
        item.type === "agentMessage" && item.text.trim().length > 0,
    )
    .map((item) => item.text);
  return {
    assistantText: parts.join("\n\n"),
    lastNonEmptyAssistantMessageText: parts.at(-1) ?? "",
  };
}
export function createCodexTurnStreamState(
  threadId: string | null,
): CodexTurnStreamState {
  const assistant = new OrderedItemText();
  const reasoning = new OrderedItemText();
  const state: CodexTurnStreamState = {
    revision: 0,
    items: new Map(),
    liveSteps: new ProviderProgressMap(),
    threadId,
    turnId: null,
    get reasoningText() { return reasoning.full(); },
    usage: null,
    usageBaseline: null,
    streamErrorMessage: "",
    turnCompleted: false,
    terminalStatus: null,
  };
  textCaches.set(state, { assistant, reasoning, order: new Map() });
  return state;
}
function usageBreakdown(value: unknown): ProviderUsage | null {
  const usage = record(value);
  if (
    typeof usage.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number"
  )
    return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens:
      typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0,
    reasoningOutputTokens:
      typeof usage.reasoningOutputTokens === "number"
        ? usage.reasoningOutputTokens
        : 0,
    totalTokens:
      typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : usage.inputTokens + usage.outputTokens,
  };
}
function subtractUsage(
  total: ProviderUsage,
  baseline: ProviderUsage,
): ProviderUsage {
  return {
    inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    cachedInputTokens: Math.max(
      0,
      total.cachedInputTokens - baseline.cachedInputTokens,
    ),
    reasoningOutputTokens: Math.max(
      0,
      (total.reasoningOutputTokens ?? 0) -
        (baseline.reasoningOutputTokens ?? 0),
    ),
    totalTokens: Math.max(
      0,
      (total.totalTokens ?? 0) - (baseline.totalTokens ?? 0),
    ),
  };
}
export function getLiveCodexAssistantText(state: CodexTurnStreamState): string {
  return textCaches.get(state)!.assistant.full();
}
export function getLiveCodexAssistantPreview(state: CodexTurnStreamState): string {
  return textCaches.get(state)!.assistant.preview();
}
export function getLiveCodexReasoningPreview(state: CodexTurnStreamState): string {
  return textCaches.get(state)!.reasoning.preview();
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function getCodexCommandOutputPreview(
  item: Extract<CodexTurnItem, { type: "commandExecution" }>,
): string | undefined {
  if (item.aggregatedOutput === null) return undefined;
  if (item.aggregatedOutputOriginalLength === undefined) return toProviderTextPreview(item.aggregatedOutput);
  const originalLength = item.aggregatedOutputOriginalLength ?? item.aggregatedOutput.length;
  if (originalLength <= PROVIDER_TEXT_PREVIEW_LIMIT) return item.aggregatedOutput;
  return `${item.aggregatedOutput}\n...[truncated ${originalLength - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${originalLength}]`;
}

function liveStep(item: CodexTurnItem): LiveRunStep | null {
  const status = "status" in item ? item.status : "completed";
  const liveStatus = status === "inProgress" ? "in_progress" : status === "declined" ? "failed" : status;
  switch (item.type) {
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        summary: toProviderTextPreview(item.command) ?? "",
        details: getCodexCommandOutputPreview(item),
        ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}),
        ...(item.aggregatedOutputOriginalLength !== undefined ? { truncated: item.aggregatedOutputOriginalLength > (item.aggregatedOutput?.length ?? 0) } : {}),
        status: liveStatus,
      };
    case "fileChange":
      return {
        id: item.id,
        type: "file_change",
        summary: item.changes
          .map((change) => `${change.kind.type}: ${change.path}`)
          .join("\n"),
        status: liveStatus,
      };
    case "mcpToolCall":
      return {
        id: item.id,
        type: "mcp_tool_call",
        summary: `${item.server}/${item.tool}`,
        ...(item.error ? { error: { message: toProviderTextPreview(item.error.message) ?? "" } } : {}),
        details:
          toProviderTextPreview(item.error?.message) ??
          stringifyBoundedProviderValue(
            item.result?.structuredContent ?? item.arguments,
          ),
        status: liveStatus,
      };
    case "collabAgentToolCall":
      return {
        id: item.id,
        type: "collab_tool_call",
        summary: item.tool,
        details: stringifyBoundedProviderValue(item.agentsStates),
        status: liveStatus,
      };
    case "webSearch":
      return {
        id: item.id,
        type: "web_search",
        summary:
          item.query ?? stringifyBoundedProviderValue(item.action) ?? "Web search",
        status: "completed",
      };
    case "plan":
      return {
        id: item.id,
        type: "plan",
        summary: toProviderTextPreview(item.text) ?? "",
        status: "completed",
      };
    default:
      return null;
  }
}
function setLiveStep(state: CodexTurnStreamState, step: LiveRunStep): boolean {
  const previous = state.liveSteps.get(step.id);
  if (previous && previous.type === step.type && previous.summary === step.summary
    && previous.details === step.details && previous.status === step.status
    && previous.exitCode === step.exitCode
    && previous.error?.message === step.error?.message
    && previous.error?.code === step.error?.code
    && previous.truncated === step.truncated) return false;
  state.liveSteps.set(step.id, step);
  return true;
}
function acceptItem(state: CodexTurnStreamState, value: unknown, boundedOutput = false): void {
  const raw = record(value);
  if (typeof raw.id !== "string" || typeof raw.type !== "string")
    throw new Error("Invalid Codex App Server item");
  let item = value as CodexTurnItem;
  if (!boundedOutput && item.type === "commandExecution" && typeof item.aggregatedOutput === "string") {
    // A sliced prefix can still retain the native output's full backing string.
    item = {
      ...item,
      aggregatedOutputOriginalLength: item.aggregatedOutput.length,
      aggregatedOutput: item.aggregatedOutput.length > PROVIDER_TEXT_PREVIEW_LIMIT
        ? JSON.parse(JSON.stringify(item.aggregatedOutput.slice(0, PROVIDER_TEXT_PREVIEW_LIMIT))) as string
        : item.aggregatedOutput,
    };
  }
  state.items.set(item.id, item);
  const cache = textCaches.get(state)!;
  let order = cache.order.get(item.id);
  if (order === undefined) {
    order = cache.order.size;
    cache.order.set(item.id, order);
  }
  let changed = cache.assistant.set(item.id, order,
    item.type === "agentMessage" && item.text.trim().length > 0 ? item.text : "");
  changed = cache.reasoning.set(item.id, order,
    item.type === "reasoning" ? [...item.summary, ...item.content].join("\n") : "") || changed;
  const step = liveStep(item);
  if (step) changed = setLiveStep(state, step) || changed;
  if (!state.turnCompleted && state.streamErrorMessage) {
    state.streamErrorMessage = "";
    changed = true;
  }
  if (changed) state.revision += 1;
}
export function applyCodexTurnEvent(
  state: CodexTurnStreamState,
  event: CodexNativeNotification,
): void {
  const params = record(event.params);
  if (typeof params.threadId === "string" && params.threadId !== state.threadId)
    return;
  const turn = record(params.turn);
  const incomingTurnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof turn.id === "string"
        ? turn.id
        : null;
  if (state.turnId && incomingTurnId && incomingTurnId !== state.turnId) {
    if (event.method === "thread/tokenUsage/updated" && state.usage === null)
      state.usageBaseline = usageBreakdown(record(params.tokenUsage).total);
    return;
  }
  const previousRevision = state.revision;
  const previousTurnId = state.turnId;
  const previousError = state.streamErrorMessage;
  const previousCompleted = state.turnCompleted;
  const previousStatus = state.terminalStatus;
  const previousUsage = state.usage;
  switch (event.method) {
    case "turn/started":
      if (typeof turn.id === "string") state.turnId = turn.id;
      break;
    case "item/started":
    case "item/completed":
      acceptItem(state, params.item);
      break;
    case "item/agentMessage/delta": {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string")
        break;
      const item = state.items.get(params.itemId);
      if (item?.type === "agentMessage") {
        acceptItem(state, { ...item, text: item.text + params.delta });
      }
      break;
    }
    case "item/commandExecution/outputDelta": {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string")
        break;
      const item = state.items.get(params.itemId);
      if (item?.type === "commandExecution") {
        const remaining = Math.max(0, PROVIDER_TEXT_PREVIEW_LIMIT - (item.aggregatedOutput?.length ?? 0));
        const prefix = params.delta.length > remaining
          ? JSON.parse(JSON.stringify(params.delta.slice(0, remaining))) as string
          : params.delta;
        const next = {
          ...item,
          aggregatedOutput: (item.aggregatedOutput ?? "") + prefix,
          aggregatedOutputOriginalLength: (item.aggregatedOutputOriginalLength ?? item.aggregatedOutput?.length ?? 0) + params.delta.length,
        };
        acceptItem(state, next, true);
      }
      break;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string")
        break;
      const item = state.items.get(params.itemId);
      if (item?.type !== "reasoning") break;
      const key =
        event.method === "item/reasoning/summaryTextDelta"
          ? "summary"
          : "content";
      const index =
        typeof params.summaryIndex === "number"
          ? params.summaryIndex
          : typeof params.contentIndex === "number"
            ? params.contentIndex
            : 0;
      if (!Number.isInteger(index) || index < 0 || index > 1000) break;
      const texts = [...item[key]];
      texts[index] = (texts[index] ?? "") + params.delta;
      acceptItem(state, { ...item, [key]: texts });
      break;
    }
    case "thread/tokenUsage/updated": {
      const tokenUsage = record(params.tokenUsage);
      const total = usageBreakdown(tokenUsage.total);
      const last = usageBreakdown(tokenUsage.last);
      if (!total || !last) break;
      // Native total is thread-cumulative; last describes one model response.
      state.usageBaseline ??= subtractUsage(total, last);
      state.usage = subtractUsage(total, state.usageBaseline);
      break;
    }
    case "turn/plan/updated": {
      if (!Array.isArray(params.plan)) break;
      const steps = params.plan.map(record);
      if (setLiveStep(state, {
        id: "turn-plan",
        type: "plan",
        summary: `${steps.filter((step) => step.status === "completed").length}/${steps.length} completed`,
        details: toProviderTextPreview(
          steps
            .map(
              (step) =>
                `${step.status === "completed" ? "[x]" : "[ ]"} ${typeof step.step === "string" ? step.step : ""}`,
            )
            .join("\n"),
        ),
        status: steps.every((step) => step.status === "completed")
          ? "completed"
          : "in_progress",
      })) state.revision += 1;
      break;
    }
    case "error": {
      const error = record(params.error);
      state.streamErrorMessage =
        typeof error.message === "string"
          ? error.message
          : "Codex App Server error";
      break;
    }
    case "turn/completed":
      if (typeof turn.id !== "string" || typeof turn.status !== "string")
        throw new Error("Invalid Codex App Server terminal turn");
      state.turnId = turn.id;
      if (Array.isArray(turn.items))
        for (const item of turn.items) acceptItem(state, item);
      state.terminalStatus = turn.status;
      state.turnCompleted = true;
      state.streamErrorMessage =
        turn.status === "completed"
          ? ""
          : typeof record(turn.error).message === "string"
            ? (record(turn.error).message as string)
            : `Codex turn ${turn.status}`;
      break;
  }
  const usageChanged = previousUsage !== state.usage
    && JSON.stringify(previousUsage) !== JSON.stringify(state.usage);
  state.revision = previousRevision + Number(state.revision !== previousRevision
    || previousTurnId !== state.turnId || previousError !== state.streamErrorMessage
    || previousCompleted !== state.turnCompleted || previousStatus !== state.terminalStatus
    || usageChanged);
}
