import type { Message } from "./session-state.js";
import type { MessageListSource } from "./auxiliary-session-message-projection.js";
import { projectMessageRenderedSearchText } from "./message-rendered-search-text.js";

export const MESSAGE_COLLAPSE_PREVIEW_MAX_LENGTH = 160;
export const MESSAGE_COLLAPSE_EMPTY_PREVIEW = "内容なし";

export type MessageCollapseTarget = Readonly<{
  key: string;
  sourceIdentity: string;
  sourceKind: "session" | "auxiliary";
  role: Message["role"];
  text: string;
  preview: string;
  accent: boolean;
}>;

export type MessageCollapseStateEntry = Readonly<{
  sourceIdentity: string;
  role: Message["role"];
  text: string;
}>;

export type MessageCollapseState = ReadonlyMap<string, MessageCollapseStateEntry>;

export type MessageNavigatorEntry = Readonly<{
  key: string;
  sourceKind: MessageCollapseTarget["sourceKind"];
  role: Message["role"];
  preview: string;
  accent: boolean;
  isCollapsed: boolean;
}>;

export type MessageJumpRequest = Readonly<{
  sessionId: string;
  key: string;
  requestId: number;
}>;

function messageSourceIdentity(source: MessageListSource): string {
  switch (source.kind) {
    case "session":
      return `session:${source.messageIndex}`;
    case "auxiliary":
      return `auxiliary:${source.sessionId}:${source.messageIndex}`;
    case "live-assistant":
      return `live-assistant:${source.sessionId}:${source.threadId ?? "pending"}`;
    default:
      return "unknown";
  }
}

export function isMessageCollapseTarget(
  source: MessageListSource | undefined,
  role: Message["role"] | undefined,
  key?: string,
): source is Extract<MessageListSource, { kind: "session" | "auxiliary" }> {
  return (source?.kind === "session" || source?.kind === "auxiliary")
    && !key?.startsWith("live-assistant-")
    && (role === "user" || role === "assistant");
}

function normalizeMessagePlainText(text: string): string {
  const normalized = text
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return MESSAGE_COLLAPSE_EMPTY_PREVIEW;
  }

  const codePoints = Array.from(normalized);
  if (codePoints.length <= MESSAGE_COLLAPSE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }

  return `${codePoints.slice(0, MESSAGE_COLLAPSE_PREVIEW_MAX_LENGTH - 1).join("")}…`;
}

export function projectMessagePlainText(markdown: string): string {
  return normalizeMessagePlainText(projectMessageRenderedSearchText(markdown.replace(/\r\n?|\n/gu, " ")));
}

export function buildMessageCollapseTargets(
  messages: readonly Message[],
  sources: readonly MessageListSource[],
  keys: readonly string[],
): MessageCollapseTarget[] {
  const targets: MessageCollapseTarget[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const source = sources[index];
    const key = keys[index];
    if (!message || !key || !isMessageCollapseTarget(source, message.role, key)) {
      continue;
    }

    targets.push({
      key,
      sourceIdentity: messageSourceIdentity(source),
      sourceKind: source.kind,
      role: message.role,
      text: message.text,
      preview: projectMessagePlainText(message.text),
      accent: message.accent === true,
    });
  }
  return targets;
}

function isMatchingCollapseStateEntry(
  entry: MessageCollapseStateEntry | undefined,
  target: MessageCollapseTarget,
): boolean {
  return entry?.sourceIdentity === target.sourceIdentity
    && entry.role === target.role
    && entry.text === target.text;
}

export function reconcileMessageCollapseState(
  state: MessageCollapseState,
  targets: readonly MessageCollapseTarget[],
): Map<string, MessageCollapseStateEntry> {
  const targetsByKey = new Map(targets.map((target) => [target.key, target]));
  const next = new Map<string, MessageCollapseStateEntry>();
  for (const [key, entry] of state) {
    const target = targetsByKey.get(key);
    if (target && isMatchingCollapseStateEntry(entry, target)) {
      next.set(key, entry);
    }
  }
  return next;
}

export function toggleMessageCollapseState(
  state: MessageCollapseState,
  target: MessageCollapseTarget,
): Map<string, MessageCollapseStateEntry> {
  // The caller reconciles the complete projection before toggling. Preserve
  // unrelated entries here so an individual toggle cannot clear other rows.
  const next = new Map(state);
  const current = next.get(target.key);
  if (current && isMatchingCollapseStateEntry(current, target)) {
    next.delete(target.key);
  } else {
    next.set(target.key, {
      sourceIdentity: target.sourceIdentity,
      role: target.role,
      text: target.text,
    });
  }
  return next;
}

export function toggleAllMessageCollapseState(
  state: MessageCollapseState,
  targets: readonly MessageCollapseTarget[],
): Map<string, MessageCollapseStateEntry> {
  const reconciled = reconcileMessageCollapseState(state, targets);
  if (targets.length > 0 && targets.every((target) => reconciled.has(target.key))) {
    return new Map();
  }

  return new Map(targets.map((target) => [target.key, {
    sourceIdentity: target.sourceIdentity,
    role: target.role,
    text: target.text,
  }]));
}

export function buildMessageNavigatorEntries(
  targets: readonly MessageCollapseTarget[],
  state: MessageCollapseState,
): MessageNavigatorEntry[] {
  return targets.map((target) => ({
    key: target.key,
    sourceKind: target.sourceKind,
    role: target.role,
    preview: target.preview,
    accent: target.accent,
    isCollapsed: state.has(target.key),
  }));
}

export function findMessageIndexByKey(keys: readonly string[], key: string): number {
  return keys.indexOf(key);
}
