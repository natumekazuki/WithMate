import {
  isMessageBookmarked,
  type Message,
} from "../../../src-shared/session/session-state.js";
import type { MessageListSource } from "../auxiliary/auxiliary-session-message-projection.js";
import { projectMessagePlainText } from "../../../src-shared/session/message-search.js";
import {
  conversationInputSpeaker,
  type ConversationInputSpeaker,
} from "../../../src-shared/session/conversation-page.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";

/** 折りたたみ可能な履歴行。その出所と本文、ナビゲーター用の表示情報を保持する。 */
export type MessageCollapseTarget = Readonly<{
  key: string;
  sourceIdentity: string;
  sourceKind: "session" | "auxiliary";
  source: Extract<MessageListSource, { kind: "session" | "auxiliary" }>;
  role: Message["role"];
  text: string;
  preview: string;
  responseProvider?: string;
  accent: boolean;
  isBookmarked: boolean;
  speaker?: ConversationInputSpeaker;
}>;

/** 同じ行キーが使われても折りたたみを別の本文へ引き継がないための照合情報。 */
export type MessageCollapseStateEntry = Readonly<{
  sourceIdentity: string;
  role: Message["role"];
  text: string;
}>;

/** 折りたたまれている履歴行を行キーから引く状態。 */
export type MessageCollapseState = ReadonlyMap<
  string,
  MessageCollapseStateEntry
>;

/** ナビゲーターが履歴行のプレビューと移動先、現在の表示状態を提示するための項目。 */
export type MessageNavigatorEntry = Readonly<{
  key: string;
  sourceKind: MessageCollapseTarget["sourceKind"];
  role: Message["role"];
  preview: string;
  accent: boolean;
  isCollapsed: boolean;
  isBookmarked: boolean;
  speaker?: ConversationInputSpeaker;
}>;

/** セッションを限定した履歴行への移動要求。返信経由の場合は要求がまだ有効かも確認できる。 */
export type MessageJumpRequest = Readonly<{
  sessionId: string;
  key: string;
  requestId: number;
  offset?: number;
  reply?: { seq: number; sentKey?: string; isCurrent: () => boolean };
}>;

/** Main の履歴位置、Auxiliary のセッションと履歴位置、または実行中のスレッドから識別子を組み立てる。 */
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

/** 確定した Main／Auxiliary のユーザー入力と応答だけを折りたたみ対象とする。 */
export function isMessageCollapseTarget(
  source: MessageListSource | undefined,
  role: Message["role"] | undefined,
): source is Extract<MessageListSource, { kind: "session" | "auxiliary" }> {
  return (
    (source?.kind === "session" || source?.kind === "auxiliary") &&
    (role === "user" || role === "assistant")
  );
}

/** 履歴の順序で折りたたみ対象を作り、本文・出所種別・プロバイダーが同じ行ではプレビューを再利用する。 */
export function buildMessageCollapseTargets(
  messages: readonly Message[],
  sources: readonly MessageListSource[],
  keys: readonly string[],
  previousTargets: readonly MessageCollapseTarget[] = [],
  provider?: string,
  receipts: readonly SessionTurnQueueReceipt[] = [],
): MessageCollapseTarget[] {
  const previousTargetsBySourceIdentity = new Map(
    previousTargets.map((target) => [target.sourceIdentity, target]),
  );
  const targets: MessageCollapseTarget[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const source = sources[index];
    const key = keys[index];
    if (!message || !key || !isMessageCollapseTarget(source, message.role)) {
      continue;
    }

    const sourceIdentity = messageSourceIdentity(source);
    const responseProvider =
      message.role === "assistant" ? provider : undefined;
    const receipt =
      message.role === "user"
        ? receipts.find((value) => value.userMessageSeq === source.messageIndex)
        : undefined;
    const origin =
      message.turnInput && !message.turnInput.queueId
        ? message.turnInput.origin
        : (receipt?.dispatched?.origin ??
          receipt?.accepted?.origin ??
          receipt?.captured.origin);
    const speaker =
      message.role === "user" ? conversationInputSpeaker(origin) : undefined;
    const previousTarget = previousTargetsBySourceIdentity.get(sourceIdentity);
    if (
      previousTarget?.key === key &&
      previousTarget.role === message.role &&
      previousTarget.text === message.text &&
      previousTarget.responseProvider === responseProvider &&
      previousTarget.sourceKind === source.kind &&
      previousTarget.accent === (message.accent === true) &&
      previousTarget.isBookmarked === isMessageBookmarked(message) &&
      JSON.stringify(previousTarget.speaker) === JSON.stringify(speaker)
    ) {
      targets.push({ ...previousTarget, source });
      continue;
    }

    targets.push({
      key,
      sourceIdentity,
      sourceKind: source.kind,
      source,
      role: message.role,
      text: message.text,
      responseProvider,
      preview:
        previousTarget?.sourceKind === source.kind &&
        previousTarget.role === message.role &&
        previousTarget.text === message.text &&
        previousTarget.responseProvider === responseProvider
          ? previousTarget.preview
          : projectMessagePlainText(message.text, responseProvider),
      accent: message.accent === true,
      isBookmarked: isMessageBookmarked(message),
      speaker,
    });
  }
  return targets;
}

/** 折りたたみ状態が同じ出所、話者の役割、本文に対応しているかを判定する。 */
function isMatchingCollapseStateEntry(
  entry: MessageCollapseStateEntry | undefined,
  target: MessageCollapseTarget,
): boolean {
  return (
    entry?.sourceIdentity === target.sourceIdentity &&
    entry.role === target.role &&
    entry.text === target.text
  );
}

/** 現在の対象に存在し、元の行と照合できる折りたたみだけを残す。 */
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

/** 指定した一行だけの折りたたみ状態を反転させ、他の行の状態は保持する。 */
export function toggleMessageCollapseState(
  state: MessageCollapseState,
  target: MessageCollapseTarget,
): Map<string, MessageCollapseStateEntry> {
  // 切り替え前に呼び出し側が投影全体の整合を取る。
  // ここでは無関係な項目を残し、一行の切り替えが他の行を消さないようにする。
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

/** 現在の対象がすべて折りたたまれていれば全展開し、それ以外は対象をすべて折りたたむ。 */
export function toggleAllMessageCollapseState(
  state: MessageCollapseState,
  targets: readonly MessageCollapseTarget[],
): Map<string, MessageCollapseStateEntry> {
  const reconciled = reconcileMessageCollapseState(state, targets);
  if (
    targets.length > 0 &&
    targets.every((target) => reconciled.has(target.key))
  ) {
    return new Map();
  }

  return new Map(
    targets.map((target) => [
      target.key,
      {
        sourceIdentity: target.sourceIdentity,
        role: target.role,
        text: target.text,
      },
    ]),
  );
}

/** 現在の折りたたみ状態を、対象の順序を変えずナビゲーター項目に反映する。 */
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
    isBookmarked: target.isBookmarked,
    speaker: target.speaker,
  }));
}

/** 指定された行キーの位置を返す。現在の表示列にない場合は -1 を返す。 */
export function findMessageIndexByKey(
  keys: readonly string[],
  key: string,
): number {
  return keys.indexOf(key);
}
