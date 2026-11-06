import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";

type SentPage = Extract<SessionExecutionReadResult<"list_sent_deliveries">, { ok: true }>;
export type SentDelivery = SentPage["items"][number];

/** One bounded read for the displayed conversation range, never one read per assistant. */
export function useSentDeliveries(context: TurnInputReadContext | undefined, messages: readonly Message[], liveTurnId: string | null | undefined, enabled: boolean) {
  const messageSeqs = [...new Set(messages.flatMap((message) => message.historyIndex === undefined ? [] : [message.historyIndex]))].slice(0, 180);
  const liveTurnIds = liveTurnId ? [liveTurnId] : [];
  const identity = JSON.stringify([context, messageSeqs, liveTurnIds]);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ identity: string; page: SentPage } | null>(null);
  const loadedData = useRef(data);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const load = useCallback(async (cursor?: number) => {
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) return;
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved outgoing deliveries are unavailable."); return; }
    const current = ++attempt.current;
    const previous = loadedData.current?.identity === identity ? loadedData.current.page : null;
    const desiredCount = cursor === undefined ? Math.max(20, previous?.items.length ?? 0) : 20;
    setBusy(true); setError("");
    try {
      const items: SentDelivery[] = [];
      let nextCursor = cursor;
      let result: SentPage;
      do {
        const response = await api.readSessionExecution(context.ownerSessionId, "list_sent_deliveries", { target: context.target, messageSeqs, liveTurnIds, ...(nextCursor === undefined ? {} : { cursor: nextCursor }), limit: 20 });
        if (attempt.current !== current) return;
        if (!response.ok) { setError(response.message); return; }
        result = response;
        items.push(...result.items);
        nextCursor = result.nextCursor ?? undefined;
      } while (nextCursor !== undefined && items.length < desiredCount);
      const next = { identity, page: { ...result, items: cursor !== undefined && previous ? [...previous.items, ...items.filter((item) => !previous.items.some((existing) => existing.receiptId === item.receiptId))] : items } };
      loadedData.current = next;
      setData(next);
    } catch (failure) {
      if (attempt.current === current) setError(failure instanceof Error ? failure.message : "Could not read outgoing deliveries.");
    } finally { if (attempt.current === current) setBusy(false); }
  }, [identity, enabled]);
  useEffect(() => {
    if (!enabled || !context) return;
    // New outgoing receipts belong to the recipient. The existing global queue
    // event therefore invalidates this one indexed source projection as well.
    return getWithMateApi()?.onSessionTurnQueueChanged?.(() => setRevision((value) => value + 1));
  }, [enabled, context?.ownerSessionId, context?.target.sessionId]);
  useEffect(() => {
    setError("");
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) { setBusy(false); return; }
    void load();
    return () => { ++attempt.current; };
  }, [load, revision]);
  const page = data?.identity === identity ? data.page : null;
  return { items: page?.items ?? [], nextCursor: page?.nextCursor ?? null, error, busy, retry: () => void load(), loadMore: () => { if (page?.nextCursor != null && !busy) void load(page.nextCursor); } };
}
