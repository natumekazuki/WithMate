import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import { conversationPeerKey } from "../../../src-shared/session/conversation-threads.js";
import type { SentInstructionCard, SentInstructionCardRequest } from "../../../src-shared/session/session-execution-read.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";
import { createSentBodyReader, type SentBodyRead } from "./sent-instruction-body.js";

type SentPage = Extract<SessionExecutionReadResult<"list_sent_deliveries">, { ok: true }>;
export type SentDelivery = SentPage["items"][number];
type SteerPage = Extract<SessionExecutionReadResult<"list_sent_steers">, { ok: true }>;
export type SentSteer = SteerPage["items"][number];
export type SentInstruction = SentInstructionCard & { bodyRead: SentBodyRead };
export const sentInstructionKey = (item: SentInstructionCard) => "receiptId" in item ? item.receiptId : `steer:${conversationPeerKey(item.target)}:${item.messageSeq}`;

type Catalogue = { scope: string; items: SentInstructionCard[]; generation: number };
const recipientIds = ({ target }: SentInstructionCard) => target.kind === "auxiliary" ? [target.sessionId, target.mainSessionId] : [target.sessionId];

/** Positioning uses a bounded catalogue. Text belongs to the individual rendered cards. */
export function useSentDeliveries(context: TurnInputReadContext | undefined, messages: readonly Message[], liveTurnId: string | null | undefined, enabled: boolean) {
  const messageSeqs = [...new Set(messages.flatMap((message) => message.historyIndex === undefined ? [] : [message.historyIndex]))].slice(0, 180);
  const liveTurnIds = liveTurnId ? [liveTurnId] : [];
  const identity = JSON.stringify([context, messageSeqs, liveTurnIds]);
  const scope = useMemo((): SentInstructionCardRequest | null =>
    context && (messageSeqs.length || liveTurnIds.length) ? { target: context.target, messageSeqs, liveTurnIds } : null, [identity]);
  const owner = context?.ownerSessionId;
  const reader = useMemo(() => owner && scope ? createSentBodyReader(owner, scope) : null, [owner, scope, enabled]);
  const [data, setData] = useState<Catalogue | null>(null);
  const current = useRef<Catalogue | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const retry = useRef<() => void>(undefined);

  useEffect(() => {
    setError("");
    setBusy(false);
    if (!enabled || !scope || !owner) return;
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved outgoing messages are unavailable."); return; }
    let active = true;
    let inFlight = false;
    let scheduled = false;
    let changed = 0;
    const unknownRecipients = new Set<string>();
    const publish = (items: Iterable<SentInstructionCard>, change: number) => {
      const result = { scope: identity, generation: change, items: [...items].sort((a, b) =>
        Number("receiptId" in b) - Number("receiptId" in a) || a.sequence - b.sequence) };
      current.current = result;
      setData(result);
    };
    const load = async () => {
      if (!active) return;
      const version = changed;
      const revision = ++generation.current;
      inFlight = true;
      unknownRecipients.clear();
      setError("");
      setBusy(true);
      const read = new Map<string, SentInstructionCard>();
      const previous = current.current?.scope === identity ? current.current.items : [];
      const visible = new Map(previous.map((item) => [sentInstructionKey(item), item]));
      let cursors: SentInstructionCardRequest["cursors"];
      try {
        do {
          const response = await api.readSessionExecution(owner, "list_sent_instruction_cards", { ...scope, ...(cursors ? { cursors } : {}) });
          if (!active || version !== changed) return;
          if (!response.ok) { setError(response.message); return; }
          if (response.items.some((item) => recipientIds(item).some((id) => unknownRecipients.has(id)))) { changed++; return; }
          for (const item of response.items) {
            const key = sentInstructionKey(item);
            read.set(key, item);
            visible.set(key, item);
          }
          if (response.cursors.receipts === null && response.cursors.steers === null) {
            publish(read.values(), revision);
            return;
          }
          // An absent card is not deleted until a complete sweep in this scope succeeds.
          publish(visible.values(), revision);
          cursors = response.cursors;
        } while (active);
      } catch (failure) {
        if (active && version === changed) setError(failure instanceof Error ? failure.message : "Could not read outgoing messages.");
      } finally {
        inFlight = false;
        if (active) {
          if (version !== changed) schedule();
          else setBusy(false);
        }
      }
    };
    const schedule = () => {
      if (inFlight || scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; void load(); });
    };
    const invalidate = () => { changed++; schedule(); };
    const sourceChanged = (id: string) => { if (id === scope.target.sessionId) invalidate(); };
    const subscriptions = [
      api.onSessionSentDeliveriesChanged?.(sourceChanged),
      // Existing source-position verification uses the source's queue event.
      api.onSessionTurnQueueChanged?.(sourceChanged),
      api.subscribeSessionInvalidation?.((event) => {
        if (event.detailChanged === false) return;
        const items = current.current?.scope === identity ? current.current.items : [];
        if (event.scope === "all" || event.sessionIds.includes(scope.target.sessionId)
          || items.some((item) => recipientIds(item).some((id) => event.sessionIds.includes(id)))) invalidate();
        else if (inFlight) for (const id of event.sessionIds) unknownRecipients.add(id);
      }),
    ];
    retry.current = invalidate;
    schedule();
    return () => { active = false; retry.current = undefined; for (const unsubscribe of subscriptions) unsubscribe?.(); };
  }, [enabled, owner, scope, identity]);

  const items = useMemo(() => data?.scope === identity && reader ? data.items.map((item): SentInstruction => ({
    ...item, bodyRead: {
      key: { sourceTurnId: item.sourceTurnId, sequence: item.sequence, recipient: item.target,
        ...("receiptId" in item ? { receiptId: item.receiptId } : { messageSeq: item.messageSeq }) },
      read: reader, revision: "receiptId" in item ? 0 : data.generation, enabled,
    },
  })) : [], [data, identity, reader, enabled]);
  return { items, error, busy, retry: () => retry.current?.() };
}
