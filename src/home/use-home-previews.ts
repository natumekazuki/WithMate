import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionFilePreviewContextMenuRequest, SessionFilePreviewWindowGroup } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

export type HomePreviewsApi = Pick<WithMateWindowApi,
  "listSessionFilePreviewWindows" | "subscribeSessionFilePreviewWindowsChanged" |
  "subscribeOpenSessionWindowIds" | "subscribeSessionInvalidation" |
  "focusSessionFilePreviewWindow" | "closeSessionFilePreviewWindow" | "closeSessionFilePreviewWindows" |
  "showSessionFilePreviewContextMenu" | "openSession">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useHomePreviews(api: HomePreviewsApi) {
  const [groups, setGroups] = useState<SessionFilePreviewWindowGroup[]>([]);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const mounted = useRef(false);
  const pendingRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setStatus("loading");
    setReadError("");
    try {
      const result = await api.listSessionFilePreviewWindows();
      if (!mounted.current || request !== generation.current) return;
      setGroups([...result].sort((left, right) => right.previews.length - left.previews.length));
      setStatus("loaded");
    } catch (error) {
      if (!mounted.current || request !== generation.current) return;
      setReadError(`Could not load previews: ${errorMessage(error)}`);
      setStatus("error");
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api.subscribeSessionFilePreviewWindowsChanged(() => void refresh());
    const unsubscribeSessions = api.subscribeOpenSessionWindowIds(() => void refresh());
    const unsubscribeInvalidation = api.subscribeSessionInvalidation(() => void refresh());
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
      unsubscribeSessions();
      unsubscribeInvalidation();
    };
  }, [api, refresh]);

  const act = async (key: string, operation: () => Promise<void>, description: string) => {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    setActionError("");
    try {
      await operation();
    } catch (error) {
      if (mounted.current) setActionError(`${description}: ${errorMessage(error)}`);
    } finally {
      pendingRef.current.delete(key);
      if (mounted.current) setPending(new Set(pendingRef.current));
    }
  };

  return {
    groups, status, readError, actionError, pending,
    retry: () => void refresh(),
    openSession: (ownerSessionId: string) => void act(`session:${ownerSessionId}`, () => api.openSession(ownerSessionId), "Could not open session"),
    focus: (token: string) => void act(`focus:${token}`, () => api.focusSessionFilePreviewWindow(token), "Could not focus preview"),
    showPreviewMenu: (token: string, point: SessionFilePreviewContextMenuRequest["point"]) => void act(`menu:preview:${token}`, async () => {
      const result = await api.showSessionFilePreviewContextMenu({ scope: "preview", point });
      if (result === "close" && mounted.current) {
        await act(`close:${token}`, () => api.closeSessionFilePreviewWindow(token), "Could not close preview");
      }
    }, "Could not open preview menu"),
    showGroupMenu: (ownerSessionId: string, point: SessionFilePreviewContextMenuRequest["point"]) => void act(`menu:session:${ownerSessionId}`, async () => {
      const result = await api.showSessionFilePreviewContextMenu({ scope: "session", point });
      if (result === "close" && mounted.current) {
        await act(`group:${ownerSessionId}`, () => api.closeSessionFilePreviewWindows(ownerSessionId), "Could not close previews");
      }
    }, "Could not open preview menu"),
  };
}
