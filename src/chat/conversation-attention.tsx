import { useRef } from "react";

import { ComposerIcon, type ComposerIconName } from "./composer/composer-icon.js";

export type ConversationAttentionKind = "approval" | "input-required" | "input-requested" | "new-messages";

/** 現在の対象会話の保留中リクエスト一件、または未読状態。 */
export type ConversationAttentionEntry = { kind: ConversationAttentionKind; key: string };

export type ConversationAttention = {
  /** 項目の持ち主である Main または選択中の Auxiliary の表示名。例：`Main`、`Aux · Review`。 */
  targetLabel: string;
  entries: readonly ConversationAttentionEntry[];
  /** 対象の会話が中央領域に描画されていないことを示す。 */
  isConversationHidden: boolean;
  /** 対象の会話を表示する。回答・承認・再送は行わない。 */
  onShowConversation(kinds: readonly ConversationAttentionKind[]): void;
};

const ATTENTION_ORDER: readonly ConversationAttentionKind[] = ["approval", "input-required", "input-requested", "new-messages"];
const ATTENTION_LABELS: Record<ConversationAttentionKind, string> = {
  approval: "Approval required",
  "input-required": "Input required",
  "input-requested": "Input requested",
  "new-messages": "New messages",
};
const ATTENTION_ICONS: Record<ConversationAttentionKind, ComposerIconName> = {
  approval: "approval",
  "input-required": "question",
  "input-requested": "question-optional",
  "new-messages": "new-messages",
};

function splitRequestIds(value: string): string[] {
  return value ? value.split("\n") : [];
}

/** 一つの会話の発生中のリクエストと未読状態を、個別の項目に変換する。 */
export function resolveConversationAttentionEntries(input: {
  sessionId: string | null;
  approvalRequestId: string;
  blockingElicitationRequestIds: string;
  optionalElicitationRequestIds: string;
  hasUnreadMessages: boolean;
}): ConversationAttentionEntry[] {
  if (!input.sessionId) return [];
  const owner = input.sessionId;
  return [
    ...(input.approvalRequestId ? [{ kind: "approval" as const, key: `${owner}:approval:${input.approvalRequestId}` }] : []),
    ...splitRequestIds(input.blockingElicitationRequestIds).map((id) => ({ kind: "input-required" as const, key: `${owner}:input:${id}` })),
    ...splitRequestIds(input.optionalElicitationRequestIds).map((id) => ({ kind: "input-requested" as const, key: `${owner}:input:${id}` })),
    ...(input.hasUnreadMessages ? [{ kind: "new-messages" as const, key: `${owner}:new-messages` }] : []),
  ];
}

export function orderedAttentionKinds(entries: readonly ConversationAttentionEntry[]): ConversationAttentionKind[] {
  return ATTENTION_ORDER.filter((kind) => entries.some((entry) => entry.kind === kind));
}

export type AttentionAnnouncementState = {
  /** ユーザーに通知済み、または会話で表示済みの項目。 */
  known: ReadonlySet<string>;
  /** 現在の通知の対象項目。このうち一つでも解消したら通知を終了する。 */
  announced: ReadonlySet<string>;
  message: string;
  /** 同じ文面でも再度読み上げられるよう、新しい通知のたびに変える。 */
  serial: number;
};

export const initialAttentionAnnouncementState: AttentionAnnouncementState = { known: new Set(), announced: new Set(), message: "", serial: 0 };

/**
 * 会話が非表示の間に出現した項目を通知する。再描画しても同じ項目は認識済みのままとし、
 * 解消した項目は忘れる。会話の表示中に出現した項目は表示済みとして扱い、
 * プレビューに戻ったときに通知し直さない。
 */
export function advanceAttentionAnnouncement(
  state: AttentionAnnouncementState,
  entries: readonly ConversationAttentionEntry[],
  isConversationHidden: boolean,
  targetLabel: string,
): AttentionAnnouncementState {
  const fresh = isConversationHidden ? entries.filter((entry) => !state.known.has(entry.key)) : [];
  const known = new Set(entries.map((entry) => entry.key));
  if (fresh.length > 0) {
    const kinds = orderedAttentionKinds(fresh);
    const labels = kinds.map((kind) => ATTENTION_LABELS[kind]).join(", ");
    const next = kinds.some((kind) => kind !== "new-messages")
      ? "Show the chat from the Action Dock to respond."
      : "Show the chat from the Action Dock to read them.";
    return { known, announced: new Set(fresh.map((entry) => entry.key)), message: `${targetLabel}: ${labels}. ${next}`, serial: state.serial + 1 };
  }
  const isMessageCurrent = isConversationHidden && [...state.announced].every((key) => known.has(key));
  const message = isMessageCurrent ? state.message : "";
  return message === state.message && known.size === state.known.size && entries.every((entry) => state.known.has(entry.key))
    ? state
    : { known, announced: isMessageCurrent ? state.announced : new Set(), message, serial: state.serial };
}

/** 会話の要確認事項について支援技術に読み上げさせる単一の通知。 */
export function ConversationAttentionAnnouncement({ attention }: { attention?: ConversationAttention }) {
  const stateRef = useRef(initialAttentionAnnouncementState);
  const entries = attention?.entries ?? [];
  stateRef.current = advanceAttentionAnnouncement(stateRef.current, entries, attention?.isConversationHidden ?? false, attention?.targetLabel ?? "");
  const { message, serial } = stateRef.current;
  return (
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message ? <span key={serial}>{message}</span> : null}
    </span>
  );
}

/** すべての Action Dock 行で共有する、アイコンを主とした非表示の会話への入口。 */
export function ConversationAttentionButton({ attention }: { attention?: ConversationAttention }) {
  if (!attention?.isConversationHidden || attention.entries.length === 0) return null;
  const kinds = orderedAttentionKinds(attention.entries);
  const label = `${attention.targetLabel}: ${kinds.map((kind) => ATTENTION_LABELS[kind]).join(", ")}. Show Chat`;
  return (
    <button
      className={`drawer-toggle compact secondary composer-icon-button conversation-attention-button kind-${kinds[0]}`}
      type="button"
      aria-label={label}
      title={label}
      onClick={() => attention.onShowConversation(kinds)}
    >
      <ComposerIcon name={ATTENTION_ICONS[kinds[0]]} />
    </button>
  );
}
