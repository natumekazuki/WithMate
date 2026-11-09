import { useCallback, useEffect, useRef, useState } from "react";
import type { CoordinationSummary } from "../../src-shared/coordination/coordination-contract.js";
import type { SessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";

export type CoordinationMonitorGroup = {
  session: SessionSummary;
  auxiliarySessions: AuxiliarySessionSummary[];
  items: CoordinationSummary[];
};
export function useCoordinationMonitor() {
  const [groups, setGroups] = useState<CoordinationMonitorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const retry = useCallback(() => {
    generation.current += 1;
    setRevision((current) => current + 1);
  }, []);
  useEffect(() => {
    const api = getWithMateApi();
    if (!api) {
      setLoading(false);
      setError("A desktop runtime is required.");
      return;
    }
    const current = ++generation.current;
    setLoading(true);
    void (async () => {
      const items: CoordinationSummary[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const result = await api.executeCoordination({
          operation: "list",
          allCrews: true,
          userPending: true,
          offset,
          limit: 100,
        });
        if (generation.current !== current) return;
        if (!("items" in result))
          throw new Error("Invalid Coordination summary response.");
        items.push(...result.items);
        offset = result.nextOffset;
      }
      const grouped = new Map<string, CoordinationSummary[]>();
      for (const item of items) {
        const existing = grouped.get(item.initiatorMainSessionId) ?? [];
        existing.push(item);
        grouped.set(item.initiatorMainSessionId, existing);
      }
      const next = await Promise.all(
        [...grouped].map(async ([id, entries]) => {
          const [session, auxiliarySessions] = await Promise.all([
            api.getSessionSummary(id), api.listAuxiliarySessions(id),
          ]);
          if (!session)
            throw new Error(
              "A Coordination Session is no longer available. Refresh to check the saved state.",
            );
          return { session, auxiliarySessions, items: entries };
        }),
      );
      if (generation.current === current) {
        setGroups(next);
        setError("");
      }
    })()
      .catch((reason: unknown) => {
        if (generation.current === current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load Coordination.",
          );
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [revision]);
  useEffect(() => {
    const unsubscribe = getWithMateApi()?.subscribeCoordinationChanged(retry);
    window.addEventListener("focus", retry);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", retry);
    };
  }, [retry]);
  const open = async (group: CoordinationMonitorGroup) => {
    const api = getWithMateApi();
    if (!api) return;
    const first = group.items[0];
    if (!first) return;
    try {
      await api.openCoordination({
        ...first.initiator,
        ...(group.items.length === 1 ? { id: first.id } : {}),
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not open Coordination.",
      );
    }
  };
  return { groups, loading, error, retry, open };
}
