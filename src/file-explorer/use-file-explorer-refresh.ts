import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { subscribeSessionLiveEvents, type SessionLiveIngressApi } from "../chat/runtime/session-window-live-ingress.js";

type ExplorerTab = "files" | "changes" | "history";
const REFRESH_COALESCE_MS = 150;

/** Event invalidation only. Each pane owns its initial/activation read and in-flight queue. */
export function useFileExplorerRefresh(input: {
  api: SessionLiveIngressApi | null;
  ownerKey: string;
  relatedSessionIds: readonly string[];
  enabled: boolean;
  visible: boolean;
  activeTab: ExplorerTab;
}) {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const [revisions, setRevisions] = useState({ files: 0, changes: 0, history: 0 });
  const visible = input.visible && documentVisible;
  const currentRef = useRef({ ...input, visible });
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activatedAtRef = useRef(Date.now());
  const relatedIdsKey = JSON.stringify([...new Set(input.relatedSessionIds)].sort());

  const clearPending = useCallback(() => {
    if (pendingRef.current !== null) clearTimeout(pendingRef.current);
    pendingRef.current = null;
  }, []);
  const refresh = useCallback((tab: ExplorerTab) => {
    setRevisions((current) => ({ ...current, [tab]: current[tab] + 1 }));
  }, []);

  useLayoutEffect(() => {
    currentRef.current = { ...input, visible };
  });
  useLayoutEffect(() => {
    clearPending();
    activatedAtRef.current = Date.now();
    return clearPending;
  }, [input.ownerKey, input.enabled, input.activeTab, visible, clearPending]);

  const schedule = useCallback(() => {
    const current = currentRef.current;
    if (!current.enabled || !current.visible || document.visibilityState === "hidden" || pendingRef.current !== null) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      const latest = currentRef.current;
      if (latest.enabled && latest.visible && document.visibilityState !== "hidden") refresh(latest.activeTab);
    }, REFRESH_COALESCE_MS);
  }, [refresh]);

  useEffect(() => {
    const onVisibilityChange = () => {
      clearPending();
      setDocumentVisible(document.visibilityState !== "hidden");
    };
    const onFocus = () => {
      // A visibility/tab activation already starts a read; focus in the same burst adds none.
      if (Date.now() - activatedAtRef.current >= REFRESH_COALESCE_MS) schedule();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [clearPending, schedule]);

  useEffect(() => {
    if (!input.api) return;
    const relatedIds = new Set<string>(JSON.parse(relatedIdsKey));
    const runs = new Map<string, { terminal: boolean; turnId?: string }>();
    return subscribeSessionLiveEvents(input.api, (id, state) => {
      if (!relatedIds.has(id)) return;
      const terminal = !state || state.runState === "idle" || state.runState === "error";
      const previous = runs.get(id);
      if (terminal && previous?.terminal && (!state?.turnId || previous.turnId === state.turnId)) return;
      runs.set(id, { terminal, turnId: state?.turnId });
      if (terminal) schedule();
    });
  }, [input.api, input.ownerKey, relatedIdsKey, schedule]);

  return { visible, revisions, refresh };
}
