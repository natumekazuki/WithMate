import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SessionFilePin, SessionFileRootResourceRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

export type FilePinsApi = Pick<WithMateWindowApi, "listSessionFilePins" | "pinSessionFile" | "unpinSessionFile">;
const EMPTY_PINS: SessionFilePin[] = [];

type PinsState = {
  ownerKey: string;
  pins: SessionFilePin[];
  status: "loading" | "ready" | "error";
  pending: boolean;
  error: string;
};

function samePin(left: SessionFilePin, right: SessionFilePin): boolean {
  return left.rootKind === right.rootKind && left.rootPath === right.rootPath && left.relativePath === right.relativePath;
}

export function useSessionFilePins(input: {
  api: FilePinsApi | null;
  sessionId: string | null;
  enabled: boolean;
  rootsRevision: string;
}) {
  const { api, sessionId, enabled, rootsRevision } = input;
  const ownerKey = JSON.stringify([sessionId, rootsRevision, enabled]);
  const ownerRef = useRef(ownerKey);
  const sequenceRef = useRef(0);
  const mutationRef = useRef(false);
  const [state, setState] = useState<PinsState>({ ownerKey, pins: [], status: "loading", pending: false, error: "" });
  useLayoutEffect(() => {
    ownerRef.current = ownerKey;
    mutationRef.current = false;
    return () => { ownerRef.current = ""; };
  }, [ownerKey]);

  const refresh = useCallback(async () => {
    if (!api || !sessionId || !enabled || mutationRef.current) return;
    const sequence = ++sequenceRef.current;
    setState((current) => ({
      ownerKey,
      pins: current.ownerKey === ownerKey ? current.pins : [],
      status: "loading",
      pending: false,
      error: "",
    }));
    try {
      const pins = await api.listSessionFilePins(sessionId);
      if (ownerRef.current !== ownerKey || sequenceRef.current !== sequence) return;
      setState({ ownerKey, pins, status: "ready", pending: false, error: "" });
    } catch (error) {
      if (ownerRef.current !== ownerKey || sequenceRef.current !== sequence) return;
      setState((current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : "Pins could not be loaded." }));
    }
  }, [api, enabled, ownerKey, sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const changePin = async (target: SessionFileRootResourceRequest | SessionFilePin, remove: boolean): Promise<boolean> => {
    if (!api || !sessionId || !enabled || mutationRef.current || state.ownerKey !== ownerKey || state.status !== "ready") return false;
    mutationRef.current = true;
    const sequence = ++sequenceRef.current;
    setState((current) => ({ ...current, pending: true, error: "" }));
    try {
      let saved: SessionFilePin | null = null;
      if (remove && "rootPath" in target) {
        await api.unpinSessionFile({ sessionId, rootKind: target.rootKind, rootPath: target.rootPath, relativePath: target.relativePath });
      } else if (!remove && "sessionId" in target) {
        saved = await api.pinSessionFile(target);
      } else {
        throw new Error("The pin target is invalid.");
      }
      if (ownerRef.current !== ownerKey || sequenceRef.current !== sequence) return false;
      const nextPin = saved;
      setState((current) => ({
        ...current,
        pins: nextPin
          ? [...current.pins.filter((pin) => !samePin(pin, nextPin)), nextPin]
          : current.pins.filter((pin) => !("rootPath" in target && samePin(pin, target))),
        pending: false,
      }));
      return true;
    } catch (error) {
      if (ownerRef.current === ownerKey && sequenceRef.current === sequence) {
        // A storage failure can leave the commit outcome unknown. Reload before another mutation.
        setState((current) => ({ ...current, pending: false, status: "error", error: error instanceof Error ? error.message : "The pin could not be saved." }));
      }
      return false;
    } finally {
      if (ownerRef.current === ownerKey && sequenceRef.current === sequence) mutationRef.current = false;
    }
  };

  const current = state.ownerKey === ownerKey ? state : { ownerKey, pins: EMPTY_PINS, status: "loading" as const, pending: false, error: "" };
  return { ...current, refresh, changePin, canChange: enabled && current.status === "ready" && !current.pending };
}
