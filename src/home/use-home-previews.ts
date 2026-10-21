import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionFilePreviewWindowGroup } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

export type HomePreviewsApi = Pick<WithMateWindowApi,
  "listSessionFilePreviewWindows" | "subscribeSessionFilePreviewWindowsChanged" |
  "focusSessionFilePreviewWindow" | "closeSessionFilePreviewWindow" | "closeSessionFilePreviewWindows">;

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
      setGroups(result.filter((group) => group.previews.length > 0));
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
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
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
    focus: (token: string) => void act(`focus:${token}`, () => api.focusSessionFilePreviewWindow(token), "Could not focus preview"),
    close: (token: string) => void act(`close:${token}`, () => api.closeSessionFilePreviewWindow(token), "Could not close preview"),
    closeGroup: (ownerSessionId: string) => void act(`group:${ownerSessionId}`, () => api.closeSessionFilePreviewWindows(ownerSessionId), "Could not close previews"),
  };
}
