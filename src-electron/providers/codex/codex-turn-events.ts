import {
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from "@openai/codex-sdk";

import type { AuditLogUsage, LiveRunStep } from "../../../src-shared/session/runtime-state.js";
import { normalizeCodexTokenUsage } from "../provider-token-usage.js";
import {
  stringifyBoundedAuditValue,
  toAuditTextPreview,
} from "../../session/audit-payload-limits.js";

export type CodexCollabToolCallItem = {
  id: string;
  type: "collab_tool_call";
  tool?: string;
  status?: string;
  agents_states?: unknown;
  error?: { message?: string };
};

export type CodexTurnItem = ThreadItem | CodexCollabToolCallItem;

export function isCodexCollabToolCallItem(item: unknown): item is CodexCollabToolCallItem {
  return Boolean(
    item
    && typeof item === "object"
    && (item as { type?: unknown }).type === "collab_tool_call"
    && typeof (item as { id?: unknown }).id === "string",
  );
}

export type CodexTurnStreamState = {
  items: Map<string, CodexTurnItem>;
  liveSteps: Map<string, LiveRunStep>;
  threadId: string | null;
  streamedAssistantText: string;
  finalAssistantText: string;
  reasoningText: string;
  usage: Usage | null;
  liveUsage: AuditLogUsage | null;
  streamErrorMessage: string;
  turnCompleted: boolean;
};

type CodexEventRecord = Record<string, unknown>;

export function collectCodexAssistantResponseFromItems(items: Iterable<CodexTurnItem>): {
  assistantText: string;
  lastNonEmptyAssistantMessageText: string;
} {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === "agent_message" && item.text.trim().length > 0) {
      parts.push(item.text);
    }
  }
  return {
    assistantText: parts.join("\n\n"),
    lastNonEmptyAssistantMessageText: parts.at(-1) ?? "",
  };
}

function toLiveStepStatus(value: string | undefined): LiveRunStep["status"] {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  return "in_progress";
}

function buildLiveStep(item: CodexTurnItem): LiveRunStep | null {
  if (isCodexCollabToolCallItem(item)) {
    return {
      id: item.id,
      type: item.type,
      summary: item.tool ?? "collab tool",
      details: item.error?.message
        ? toAuditTextPreview(item.error.message)
        : stringifyBoundedAuditValue(item.agents_states),
      status: toLiveStepStatus(item.status),
    };
  }

  switch (item.type) {
    case "command_execution":
      return { id: item.id, type: item.type, summary: toAuditTextPreview(item.command) ?? item.command, details: toAuditTextPreview(item.aggregated_output), status: toLiveStepStatus(item.status) };
    case "file_change":
      return { id: item.id, type: item.type, summary: item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n"), status: toLiveStepStatus(item.status) };
    case "mcp_tool_call":
      return { id: item.id, type: item.type, summary: `${item.server}/${item.tool}`, details: item.error?.message ? toAuditTextPreview(item.error.message) : stringifyBoundedAuditValue(item.result?.structured_content ?? item.arguments), status: toLiveStepStatus(item.status) };
    case "web_search":
      return { id: item.id, type: item.type, summary: item.query, status: "completed" };
    case "todo_list":
      return { id: item.id, type: item.type, summary: `${item.items.filter((entry) => entry.completed).length}/${item.items.length} completed`, details: toAuditTextPreview(item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n")), status: "completed" };
    case "error":
      return { id: item.id, type: item.type, summary: toAuditTextPreview(item.message) ?? item.message, status: "failed" };
    case "reasoning":
    case "agent_message":
    default:
      return null;
  }
}

function readStringProperty(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const record = source as CodexEventRecord;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

function readStringFromUnknown(source: unknown): string | null {
  if (typeof source === "string") {
    return source;
  }

  if (Array.isArray(source)) {
    const parts = source
      .map((item) => readStringFromUnknown(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join("") : null;
  }

  if (!source || typeof source !== "object") {
    return null;
  }

  const record = source as CodexEventRecord;
  const directValue = readStringProperty(record, [
    "delta",
    "text_delta",
    "message_delta",
    "content_delta",
    "deltaContent",
    "text",
    "content",
    "value",
    "output",
  ]);
  if (directValue !== null) {
    return directValue;
  }

  for (const key of ["delta", "data", "message", "item", "content", "output", "part"]) {
    const nestedValue = readStringFromUnknown(record[key]);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function readCodexAssistantDelta(event: ThreadEvent): string | null {
  const record = event as unknown as CodexEventRecord;
  const eventType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (!eventType.includes("delta")) {
    return null;
  }

  const isAssistantTextDelta =
    eventType.includes("agent_message")
    || eventType.includes("assistant")
    || eventType.includes("message")
    || eventType.includes("output_text");
  if (!isAssistantTextDelta) {
    return null;
  }

  return readStringFromUnknown(record);
}

function collectReasoningText(items: Iterable<CodexTurnItem>): string {
  return Array.from(items)
    .filter((item): item is Extract<ThreadItem, { type: "reasoning" }> => item.type === "reasoning")
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function createCodexTurnStreamState(threadId: string | null): CodexTurnStreamState {
  return {
    items: new Map<string, CodexTurnItem>(),
    liveSteps: new Map<string, LiveRunStep>(),
    threadId,
    streamedAssistantText: "",
    finalAssistantText: "",
    reasoningText: "",
    usage: null,
    liveUsage: null,
    streamErrorMessage: "",
    turnCompleted: false,
  };
}

export function applyCodexTurnEvent(
  state: CodexTurnStreamState,
  event: ThreadEvent,
): void {
  const assistantDelta = readCodexAssistantDelta(event);
  if (assistantDelta !== null) {
    state.streamedAssistantText += assistantDelta;
    state.streamErrorMessage = "";
  }

  switch (event.type) {
    case "thread.started":
      state.threadId = event.thread_id;
      break;
    case "turn.completed":
      state.usage = event.usage;
      state.liveUsage = normalizeCodexTokenUsage(event.usage);
      state.turnCompleted = true;
      state.streamErrorMessage = "";
      break;
    case "turn.failed":
      state.streamErrorMessage = event.error.message;
      break;
    case "error":
      state.streamErrorMessage = event.message;
      break;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      state.streamErrorMessage = "";
      state.items.set(event.item.id, event.item);
      if (event.item.type === "agent_message") {
        const { assistantText: itemAssistantText } = collectCodexAssistantResponseFromItems(state.items.values());
        if (itemAssistantText.trim().length > 0) {
          state.finalAssistantText = itemAssistantText;
        }
      }
      if (event.item.type === "reasoning") {
        state.reasoningText = collectReasoningText(state.items.values());
      }

      const liveStep = buildLiveStep(event.item);
      if (liveStep) {
        state.liveSteps.set(liveStep.id, liveStep);
      }
      break;
    }
    default:
      break;
  }
}

export function getLiveCodexAssistantText(state: CodexTurnStreamState): string {
  return state.finalAssistantText || state.streamedAssistantText;
}

export function collectCodexAssistantTextFromEventsForTesting(
  events: ThreadEvent[],
): string {
  const state = createCodexTurnStreamState(null);
  for (const event of events) {
    applyCodexTurnEvent(state, event);
  }
  return getLiveCodexAssistantText(state);
}

export function collectCodexAssistantResponseFromEventsForTesting(
  events: ThreadEvent[],
): {
  assistantText: string;
  lastNonEmptyAssistantMessageText: string;
} {
  const state = createCodexTurnStreamState(null);
  for (const event of events) {
    applyCodexTurnEvent(state, event);
  }
  const response = collectCodexAssistantResponseFromItems(state.items.values());
  return response.assistantText.trim().length > 0
    ? response
    : {
        assistantText: getLiveCodexAssistantText(state),
        lastNonEmptyAssistantMessageText: getLiveCodexAssistantText(state),
      };
}

export function collectCodexAssistantTextSnapshotsFromEventsForTesting(
  events: ThreadEvent[],
): string[] {
  const state = createCodexTurnStreamState(null);
  const snapshots: string[] = [];
  for (const event of events) {
    applyCodexTurnEvent(state, event);
    snapshots.push(getLiveCodexAssistantText(state));
  }
  return snapshots;
}

export function collectCodexReasoningTextFromEventsForTesting(
  events: ThreadEvent[],
): string {
  const state = createCodexTurnStreamState(null);
  for (const event of events) {
    applyCodexTurnEvent(state, event);
  }
  return state.reasoningText;
}
