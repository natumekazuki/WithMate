import { useRef } from "react";

import { ComposerIcon, type ComposerIconName } from "./composer/composer-icon.js";

export type ConversationAttentionKind = "approval" | "input-required" | "input-requested" | "new-messages";

/** One pending request or the unread state of the current target conversation. */
export type ConversationAttentionEntry = { kind: ConversationAttentionKind; key: string };

export type ConversationAttention = {
  /** Main or the selected Auxiliary that owns the entries, e.g. `Main` or `Aux · Review`. */
  targetLabel: string;
  entries: readonly ConversationAttentionEntry[];
  /** The target conversation is not rendered in the central area. */
  isConversationHidden: boolean;
  /** Shows the target conversation. Never answers, approves or resends. */
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

/** Projects the live requests and unread state of one conversation into per-request entries. */
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
  /** Entries that the user has already been told about or has seen in the conversation. */
  known: ReadonlySet<string>;
  /** Entries the current message was announced for; the message ends when any of them resolves. */
  announced: ReadonlySet<string>;
  message: string;
  /** Changes for every new announcement so an identical message is announced again. */
  serial: number;
};

export const initialAttentionAnnouncementState: AttentionAnnouncementState = { known: new Set(), announced: new Set(), message: "", serial: 0 };

/**
 * Announces entries that appear while the conversation is hidden. Re-renders keep the
 * same entries known, resolved entries are forgotten, and entries that appeared while the
 * conversation was visible are treated as seen so returning to a preview stays quiet.
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

/** The single assistive-technology announcement for conversation attention. */
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

/** Icon-first entry point to the hidden conversation, shared by every Action Dock row. */
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
