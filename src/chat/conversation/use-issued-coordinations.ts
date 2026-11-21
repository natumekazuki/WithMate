import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";

type Page = Extract<SessionExecutionReadResult<"list_issued_coordinations">, { ok: true }>;
export type IssuedCoordination = Page["items"][number];

/** Keep the viewed prefix across refreshes; the persisted record remains the source of truth. */
export function useIssuedCoordinations(context: TurnInputReadContext | undefined, messages: readonly Message[], liveTurnId: string | undefined, enabled: boolean) {
  const messageSeqs = [...new Set(messages.flatMap((message) => message.historyIndex === undefined ? [] : [message.historyIndex]))].slice(0, 180);
  const liveTurnIds = liveTurnId ? [liveTurnId] : [];
  const key = JSON.stringify([context, messageSeqs, liveTurnIds]);
  const [snapshot, setSnapshot] = useState<{ key: string; page: Page } | null>(null);
  const saved = useRef(snapshot);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const load = useCallback(async (cursor?: string) => {
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) return;
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved Coordination reads are unavailable."); return; }
    const current = ++generation.current;
    const previous = saved.current?.key === key ? saved.current.page : null;
    const requestedCount = cursor === undefined ? Math.max(20, previous?.items.length ?? 0) : 20;
    const items: IssuedCoordination[] = [];
    setBusy(true); setError("");
    try {
      let nextCursor = cursor;
      let page: Page;
      do {
        const result = await api.readSessionExecution(context.ownerSessionId, "list_issued_coordinations", { target: context.target, messageSeqs, liveTurnIds, ...(nextCursor ? { cursor: nextCursor } : {}), limit: 20 });
        if (generation.current !== current) return;
        if (!result.ok) {
          if (result.code === "EXECUTION_TARGET_DELETED" || result.code === "EXECUTION_TARGET_REPLACED") { saved.current = null; setSnapshot(null); }
          setError(result.message); return;
        }
        page = result;
        items.push(...page.items);
        nextCursor = page.nextCursor ?? undefined;
      } while (nextCursor !== undefined && items.length < requestedCount);
      const next = { key, page: { ...page, items: cursor && previous ? [...previous.items, ...items.filter((item) => !previous.items.some((entry) => entry.id === item.id))] : items } };
      saved.current = next; setSnapshot(next);
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : "Could not read Coordination.");
    } finally { if (generation.current === current) setBusy(false); }
  }, [key, enabled]);
  useEffect(() => {
    setError("");
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) { setBusy(false); return; }
    void load();
    return () => { ++generation.current; };
  }, [load, revision]);
  useEffect(() => {
    if (!enabled || !context) return;
    return getWithMateApi()?.subscribeCoordinationChanged?.(() => setRevision((value) => value + 1));
  }, [enabled, context?.ownerSessionId, context?.target.sessionId]);
  const page = snapshot?.key === key ? snapshot.page : null;
  return { items: page?.items ?? [], nextCursor: page?.nextCursor ?? null, error, busy, retry: () => void load(), loadMore: () => { if (page?.nextCursor && !busy) void load(page.nextCursor); } };
}
