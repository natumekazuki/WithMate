import type {
  AuditLogUsage,
  LiveRunStep,
} from "../../../src-shared/session/runtime-state.js";
import {
  toAuditTextPreview,
  stringifyBoundedAuditValue,
} from "../../session/audit-payload-limits.js";
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
  items: Map<string, CodexTurnItem>;
  liveSteps: ProviderProgressMap<LiveRunStep>;
  threadId: string | null;
  turnId: string | null;
  reasoningText: string;
  usage: AuditLogUsage | null;
  usageBaseline: AuditLogUsage | null;
  streamErrorMessage: string;
  turnCompleted: boolean;
  terminalStatus: string | null;
};

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
  return {
    items: new Map(),
    liveSteps: new ProviderProgressMap(),
    threadId,
    turnId: null,
    reasoningText: "",
    usage: null,
    usageBaseline: null,
    streamErrorMessage: "",
    turnCompleted: false,
    terminalStatus: null,
  };
}
function usageBreakdown(value: unknown): AuditLogUsage | null {
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
  total: AuditLogUsage,
  baseline: AuditLogUsage,
): AuditLogUsage {
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
  return collectCodexAssistantResponseFromItems(state.items.values())
    .assistantText;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function liveStep(item: CodexTurnItem): LiveRunStep | null {
  const status = "status" in item ? item.status : "completed";
  const liveStatus =
    status === "completed"
      ? "completed"
      : status === "failed" || status === "declined"
        ? "failed"
        : "in_progress";
  switch (item.type) {
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        summary: toAuditTextPreview(item.command) ?? "",
        details: toAuditTextPreview(item.aggregatedOutput),
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
        details:
          item.error?.message ??
          stringifyBoundedAuditValue(
            item.result?.structuredContent ?? item.arguments,
          ),
        status: liveStatus,
      };
    case "collabAgentToolCall":
      return {
        id: item.id,
        type: "collab_tool_call",
        summary: item.tool,
        details: stringifyBoundedAuditValue(item.agentsStates),
        status: liveStatus,
      };
    case "webSearch":
      return {
        id: item.id,
        type: "web_search",
        summary:
          item.query ?? stringifyBoundedAuditValue(item.action) ?? "Web search",
        status: "completed",
      };
    case "plan":
      return {
        id: item.id,
        type: "plan",
        summary: toAuditTextPreview(item.text) ?? "",
        status: "completed",
      };
    default:
      return null;
  }
}
function acceptItem(state: CodexTurnStreamState, value: unknown): void {
  const raw = record(value);
  if (typeof raw.id !== "string" || typeof raw.type !== "string")
    throw new Error("Invalid Codex App Server item");
  const item = value as CodexTurnItem;
  state.items.set(item.id, item);
  const step = liveStep(item);
  if (step) state.liveSteps.set(step.id, step);
  state.reasoningText = Array.from(state.items.values())
    .filter(
      (candidate): candidate is Extract<CodexTurnItem, { type: "reasoning" }> =>
        candidate.type === "reasoning",
    )
    .map((candidate) => [...candidate.summary, ...candidate.content].join("\n"))
    .filter(Boolean)
    .join("\n\n");
  if (!state.turnCompleted) state.streamErrorMessage = "";
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
        state.items.set(item.id, { ...item, text: item.text + params.delta });
        if (!state.turnCompleted) state.streamErrorMessage = "";
      }
      break;
    }
    case "item/commandExecution/outputDelta": {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string")
        break;
      const item = state.items.get(params.itemId);
      if (item?.type === "commandExecution")
        acceptItem(state, {
          ...item,
          aggregatedOutput: (item.aggregatedOutput ?? "") + params.delta,
        });
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
      state.liveSteps.set("turn-plan", {
        id: "turn-plan",
        type: "plan",
        summary: `${steps.filter((step) => step.status === "completed").length}/${steps.length} completed`,
        details: toAuditTextPreview(
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
      });
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
}
