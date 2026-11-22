import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";

type SentPage = Extract<SessionExecutionReadResult<"list_sent_deliveries">, { ok: true }>;
export type SentDelivery = SentPage["items"][number];
type SteerPage = Extract<SessionExecutionReadResult<"list_sent_steers">, { ok: true }>;
export type SentSteer = SteerPage["items"][number];
export type SentInstruction = SentDelivery | SentSteer;
export const sentInstructionKey = (item: SentInstruction) => "receiptId" in item ? item.receiptId : `steer:${JSON.stringify([item.target, item.messageSeq])}`;

/** Each evidence source has its own stable keyset; neither is a second ledger. */
export function useSentDeliveries(context: TurnInputReadContext | undefined, messages: readonly Message[], liveTurnId: string | null | undefined, enabled: boolean) {
  const receipts = useSentInstructions("list_sent_deliveries", context, messages, liveTurnId, enabled);
  const steers = useSentInstructions("list_sent_steers", context, messages, liveTurnId, enabled);
  return { items: [...receipts.items, ...steers.items],
    error: [receipts.error, steers.error].filter(Boolean).join(" "), busy: receipts.busy || steers.busy,
    retry: () => { receipts.retry(); steers.retry(); } };
}

/** Bounded reads for the displayed conversation range, never one per assistant. */
function useSentInstructions(operation: "list_sent_deliveries" | "list_sent_steers", context: TurnInputReadContext | undefined, messages: readonly Message[], liveTurnId: string | null | undefined, enabled: boolean) {
  const messageSeqs = [...new Set(messages.flatMap((message) => message.historyIndex === undefined ? [] : [message.historyIndex]))].slice(0, 180);
  const liveTurnIds = liveTurnId ? [liveTurnId] : [];
  const identity = JSON.stringify([context, messageSeqs, liveTurnIds]);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ identity: string; page: { items: SentInstruction[]; nextCursor: number | null } } | null>(null);
  const loadedData = useRef(data);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const load = useCallback(async () => {
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) return;
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved outgoing deliveries are unavailable."); return; }
    const current = ++attempt.current;
    const previous = loadedData.current?.identity === identity ? loadedData.current.page : null;
    setBusy(true); setError("");
    try {
      const items: SentInstruction[] = [];
      let nextCursor: number | undefined;
      do {
        const response = await api.readSessionExecution(context.ownerSessionId, operation, { target: context.target, messageSeqs, liveTurnIds, ...(nextCursor === undefined ? {} : { cursor: nextCursor }), limit: 20 });
        if (attempt.current !== current) return;
        if (!response.ok) { setError(response.message); return; }
        items.push(...response.items);
        nextCursor = response.nextCursor ?? undefined;
        const remaining = nextCursor === undefined ? [] : (previous?.items ?? []).filter((item) => item.sequence > nextCursor!);
        const next = { identity, page: { ...response, items: [...items, ...remaining] } };
        loadedData.current = next;
        setData(next);
      } while (nextCursor !== undefined);
    } catch (failure) {
      if (attempt.current === current) setError(failure instanceof Error ? failure.message : "Could not read outgoing deliveries.");
    } finally { if (attempt.current === current) setBusy(false); }
  }, [identity, enabled, operation]);
  useEffect(() => {
    if (!enabled || !context) return;
    const api = getWithMateApi();
    const changed = (sourceSessionId: string) => {
      if (sourceSessionId === context.target.sessionId) setRevision((value) => value + 1);
    };
    const sentChanged = api?.onSessionSentDeliveriesChanged?.(changed);
    // Existing source-position verification uses the source's queue event.
    const positionChanged = api?.onSessionTurnQueueChanged?.(changed);
    return () => { sentChanged?.(); positionChanged?.(); };
  }, [enabled, context?.ownerSessionId, context?.target.sessionId]);
  useEffect(() => {
    setError("");
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) { setBusy(false); return; }
    void load();
    return () => { ++attempt.current; };
  }, [load, revision]);
  const page = data?.identity === identity ? data.page : null;
  return { items: page?.items ?? [], error, busy, retry: () => void load() };
}
