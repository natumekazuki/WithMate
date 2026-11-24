import { useEffect, useRef, useState } from "react";
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
  const commands = useRef<{ key: string; load(cursor?: string): Promise<void> } | null>(null);
  useEffect(() => {
    setError("");
    setBusy(false);
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length)) return;
    const { ownerSessionId, target } = context;
    const api = getWithMateApi();
    let active = true;
    let reading = false;
    let refreshPending = false;
    async function read(cursor?: string) {
      if (!api?.readSessionExecution) { setError("Saved Coordination reads are unavailable."); return; }
      const previous = saved.current?.key === key ? saved.current.page : null;
      const requestedCount = cursor === undefined ? Math.max(20, previous?.items.length ?? 0) : 20;
      const items: IssuedCoordination[] = [];
      let nextCursor = cursor;
      let page: Page;
      do {
        const result = await api.readSessionExecution(ownerSessionId, "list_issued_coordinations", { target, messageSeqs, liveTurnIds, ...(nextCursor ? { cursor: nextCursor } : {}), limit: 20 });
        if (!active) return;
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
    }
    async function load(cursor?: string) {
      if (!active) return;
      if (reading) {
        if (cursor === undefined) refreshPending = true;
        return;
      }
      reading = true;
      setBusy(true);
      do {
        refreshPending = false;
        setError("");
        try {
          await read(cursor);
        } catch (reason) {
          if (active) setError(reason instanceof Error ? reason.message : "Could not read Coordination.");
        }
        // Catch up from the beginning, including a prefix just expanded by Load More.
        cursor = undefined;
      } while (active && refreshPending);
      reading = false;
      if (active) setBusy(false);
    }
    commands.current = { key, load };
    const unsubscribe = api?.subscribeCoordinationChanged?.(({ initiator }) => {
      if (initiator.kind === target.kind && initiator.sessionId === target.sessionId && initiator.incarnationId === target.incarnationId) void load();
    });
    void load();
    return () => { active = false; commands.current = null; unsubscribe?.(); };
  }, [key, enabled]);
  const page = snapshot?.key === key ? snapshot.page : null;
  const load = (cursor?: string) => {
    if (enabled && commands.current?.key === key) void commands.current.load(cursor);
  };
  return { items: page?.items ?? [], nextCursor: page?.nextCursor ?? null, error, busy, retry: () => load(), loadMore: () => { if (page?.nextCursor && !busy) load(page.nextCursor); } };
}
