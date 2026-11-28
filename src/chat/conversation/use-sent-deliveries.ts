import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import { conversationPeerKey } from "../../../src-shared/session/conversation-threads.js";
import type { SentInstructionCard, SentInstructionCardRequest } from "../../../src-shared/session/session-execution-read.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";
import { createSentBodyReader, type SentBodyRead, type SentBodyReader } from "./sent-instruction-body.js";

type SentPage = Extract<SessionExecutionReadResult<"list_sent_deliveries">, { ok: true }>;
export type SentDelivery = SentPage["items"][number];
type SteerPage = Extract<SessionExecutionReadResult<"list_sent_steers">, { ok: true }>;
export type SentSteer = SteerPage["items"][number];
export type SentInstruction = SentInstructionCard & { bodyRead: SentBodyRead };
export const sentInstructionKey = (item: SentInstructionCard) => "receiptId" in item ? item.receiptId : `steer:${conversationPeerKey(item.target)}:${item.messageSeq}`;

type CatalogueItem = { card: SentInstructionCard; read: SentBodyReader; revision: number };
type Catalogue = { owner: string; scope: string; items: CatalogueItem[] };
const recipientIds = ({ target }: SentInstructionCard) => target.kind === "auxiliary" ? [target.sessionId, target.mainSessionId] : [target.sessionId];

/** 表示位置の決定には件数を絞った一覧を使う。本文は描画された個々のカードが持つ。 */
export function useSentDeliveries(context: TurnInputReadContext | undefined, messages: readonly Message[], liveTurnId: string | null | undefined, enabled: boolean,
  savedSeqs?: readonly (number | undefined)[], responseTurnIds?: readonly (string | undefined)[]) {
  const messageSeqs = [...new Set((savedSeqs ?? messages.map((message) => message.historyIndex)).filter((seq) => seq !== undefined))].slice(0, 180);
  const liveTurnIds = liveTurnId ? [liveTurnId] : [];
  const sourceOwner = JSON.stringify([context?.ownerSessionId, context?.target && conversationPeerKey(context.target)]);
  const identity = JSON.stringify([sourceOwner, messageSeqs, liveTurnIds]);
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
  // 送信元 Turn の保存済み応答のシーケンスがこの列に届く前でも、その Turn の行がある場合がある。
  // 現時点で表示位置があり、送信元の incarnation が同じカードだけを残す。
  const visibleSeqs = new Set(messageSeqs);
  const visibleTurns = new Set([...(responseTurnIds ?? []), ...liveTurnIds]);
  const hasPlacement = (item: SentInstructionCard) => visibleTurns.has(item.sourceTurnId)
    || item.sourceMessageSeq !== null && visibleSeqs.has(item.sourceMessageSeq);
  const hasPlacementRef = useRef(hasPlacement);
  hasPlacementRef.current = hasPlacement;
  const bridgeTurnsRef = useRef(new Set<string>());
  bridgeTurnsRef.current = new Set(responseTurnIds?.flatMap((turn, index) => turn && savedSeqs?.[index] === undefined ? [turn] : []));

  useEffect(() => {
    setError("");
    setBusy(false);
    if (!enabled || !scope || !owner || !reader) return;
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved outgoing messages are unavailable."); return; }
    let active = true;
    let inFlight = false;
    let scheduled = false;
    let changed = 0;
    const unknownRecipients = new Set<string>();
    const publish = (items: Iterable<CatalogueItem>) => {
      const result = { owner: sourceOwner, scope: identity, items: [...items].sort(({ card: a }, { card: b }) =>
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
      const read = new Map<string, CatalogueItem>();
      const previous = current.current?.owner === sourceOwner ? current.current.items.filter(({ card }) => hasPlacementRef.current(card)) : [];
      const visible = new Map(previous.map((item) => [sentInstructionKey(item.card), item]));
      let cursors: SentInstructionCardRequest["cursors"];
      try {
        do {
          const response = await api.readSessionExecution(owner, "list_sent_instruction_cards", { ...scope, ...(cursors ? { cursors } : {}) });
          if (!active || version !== changed) return;
          if (!response.ok) {
            if (response.code === "EXECUTION_TARGET_DELETED" || response.code === "EXECUTION_TARGET_REPLACED") publish([]);
            setError(response.message);
            return;
          }
          if (response.items.some((item) => recipientIds(item).some((id) => unknownRecipients.has(id)))) { changed++; return; }
          for (const card of response.items) {
            const key = sentInstructionKey(card);
            const item = { card, read: reader, revision };
            read.set(key, item);
            visible.set(key, item);
          }
          if (response.cursors.receipts === null && response.cursors.steers === null) {
            // 保存済みの送信元位置を含まない読み取りでは、一時表示中の Turn 上のカードを無効にはできない。
            for (const item of previous) {
              const { card } = item;
              const key = sentInstructionKey(card);
              if (!read.has(key) && bridgeTurnsRef.current.has(card.sourceTurnId) && !liveTurnIds.includes(card.sourceTurnId)
                && (card.sourceMessageSeq === null || !visibleSeqs.has(card.sourceMessageSeq))) {
                read.set(key, item);
              }
            }
            publish(read.values());
            return;
          }
          // この範囲の全件走査が成功するまでは、見つからないカードを削除済みとして扱わない。
          publish(visible.values());
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
      // 既存の送信元位置の確認には、送信元のキューイベントを使う。
      api.onSessionTurnQueueChanged?.(sourceChanged),
      api.subscribeSessionInvalidation?.((event) => {
        if (event.detailChanged === false) return;
        const items = current.current?.owner === sourceOwner ? current.current.items.map((item) => item.card).filter(hasPlacementRef.current) : [];
        if (event.scope === "all" || event.sessionIds.includes(scope.target.sessionId)
          || items.some((item) => recipientIds(item).some((id) => event.sessionIds.includes(id)))) invalidate();
        else if (inFlight) for (const id of event.sessionIds) unknownRecipients.add(id);
      }),
    ];
    retry.current = invalidate;
    schedule();
    return () => { active = false; retry.current = undefined; for (const unsubscribe of subscriptions) unsubscribe?.(); };
  }, [enabled, owner, scope, identity, reader, sourceOwner]);

  const eligible = data?.owner === sourceOwner && (data.scope === identity || enabled);
  const items = eligible ? data.items.filter(({ card }) => hasPlacement(card)).map(({ card: item, read, revision }): SentInstruction => ({
    ...item, bodyRead: {
      key: { sourceTurnId: item.sourceTurnId, sequence: item.sequence, recipient: item.target,
        ...("receiptId" in item ? { receiptId: item.receiptId } : { messageSeq: item.messageSeq }) },
      read, revision: "receiptId" in item ? 0 : revision, enabled,
    },
  })) : [];
  return { items, error, busy, retry: () => retry.current?.() };
}
