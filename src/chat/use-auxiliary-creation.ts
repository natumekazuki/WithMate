import { useEffect, useRef, useState } from "react";
import type { AuxiliaryCreationRequest, AuxiliaryCreationResult, AuxiliarySession } from "../auxiliary-session-state.js";
import type { WithMateWindowAuxiliaryApi } from "../withmate-window-api.js";
import {
  blocksAuxiliaryLaunchRetry,
  buildCreateAuxiliarySessionInput,
  canCancelAuxiliaryLaunchCreation,
  matchesAuxiliaryLaunchCreationRequest,
  resolveAuxiliaryLaunchCreationFeedback,
} from "./auxiliary-launch-state.js";
import { reconcileAuxiliaryLaunchCreation } from "./auxiliary-launch-reconciliation.js";

type CreationApi = Pick<WithMateWindowAuxiliaryApi,
  "getAuxiliaryCreationContext" | "createAuxiliarySession" | "getAuxiliaryCreation" |
  "cancelAuxiliaryCreation" | "getAuxiliarySession">;
type CreationStatus = AuxiliaryCreationResult["status"];
const isTerminal = (status: CreationStatus) =>
  status === "cancelled" || status === "failed" || status === "expired" || status === "not-found";
const storageKey = (parentSessionId: string) => `withmate:auxiliary-creation:${parentSessionId}`;

function readRequest(parentSessionId: string): AuxiliaryCreationRequest | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(parentSessionId)) ?? "null") as Partial<AuxiliaryCreationRequest> | null;
    return value?.parentSessionId === parentSessionId && typeof value.clientRequestId === "string"
      && typeof value.creationContext?.generationId === "string"
      && typeof value.creationContext?.parentIncarnationId === "string"
      ? value as AuxiliaryCreationRequest : null;
  } catch {
    return null;
  }
}

function clearRequestHint(request: AuxiliaryCreationRequest): void {
  if (readRequest(request.parentSessionId)?.clientRequestId !== request.clientRequestId) return;
  try { window.localStorage.removeItem(storageKey(request.parentSessionId)); } catch { /* Reopen hint only. */ }
}

/** Keeps one selected parent's creation request separate from the launch dialog. */
export function useAuxiliaryCreation(input: {
  parentSessionId: string | null;
  api: CreationApi | null;
  onCommitted: (session: AuxiliarySession) => void;
  onFeedback: (message: string) => void;
  onDiagnostic?: (request: AuxiliaryCreationRequest, stage: "request" | "applied" | "stale-drop") => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const mounted = useRef(false);
  const requestRef = useRef<AuxiliaryCreationRequest | null>(null);
  const attemptRef = useRef<object | null>(null);
  const parentRef = useRef(input.parentSessionId);
  if (parentRef.current !== input.parentSessionId) {
    parentRef.current = input.parentSessionId;
    requestRef.current = null;
    attemptRef.current = null;
  }
  const [request, setRequest] = useState<AuxiliaryCreationRequest | null>(null);
  const [status, setStatus] = useState<CreationStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef<AuxiliaryCreationRequest | null>(null);

  const isCurrent = (candidate: AuxiliaryCreationRequest) => mounted.current
    && requestRef.current === candidate && latest.current.parentSessionId === candidate.parentSessionId;
  const finish = (candidate: AuxiliaryCreationRequest, nextStatus: CreationStatus, session?: AuxiliarySession) => {
    if (!isCurrent(candidate)) return;
    clearRequestHint(candidate);
    requestRef.current = null;
    attemptRef.current = null;
    cancellingRef.current = null;
    setRequest(null);
    setStatus(nextStatus);
    setStarting(false);
    setCancelling(false);
    if (session) {
      latest.current.onDiagnostic?.(candidate, "applied");
      latest.current.onCommitted(session);
    } else {
      latest.current.onFeedback(resolveAuxiliaryLaunchCreationFeedback({ status: nextStatus }));
    }
  };

  useEffect(() => {
    mounted.current = true;
    attemptRef.current = null;
    cancellingRef.current = null;
    const restored = input.parentSessionId ? readRequest(input.parentSessionId) : null;
    requestRef.current = restored;
    setRequest(restored);
    setStatus(restored ? "unknown" : null);
    setStarting(false);
    setCancelling(false);
    return () => {
      mounted.current = false;
      requestRef.current = null;
      attemptRef.current = null;
    };
  }, [input.parentSessionId, input.api]);

  useEffect(() => {
    const api = input.api;
    if (!request || !api) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = async () => {
      try {
        const result = await reconcileAuxiliaryLaunchCreation({
          request,
          getCreation: (candidate) => api.getAuxiliaryCreation(candidate),
          getSession: (id) => api.getAuxiliarySession(id),
          isCurrent: (candidate) => !stopped && isCurrent(candidate),
          onStatus: (nextStatus) => setStatus(nextStatus),
          onCommittedSession: (session) => finish(request, "committed", session),
        });
        if (result.stale) latest.current.onDiagnostic?.(request, "stale-drop");
        if (!result.stale && isTerminal(result.status)) finish(request, result.status);
      } catch {
        if (!stopped && isCurrent(request)) {
          setStatus("unknown");
          latest.current.onFeedback(resolveAuxiliaryLaunchCreationFeedback({ status: "unknown" }));
        }
      }
      // One query at a time. Keep unknown/committing requests recoverable,
      // and stop after terminal settlement instead of reapplying every poll.
      if (!stopped && isCurrent(request)) timer = setTimeout(() => { void query(); }, 500);
    };
    // Creation is dispatched in the same task that installs the request;
    // querying immediately could observe not-found before its admission.
    timer = setTimeout(() => { void query(); }, 500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [request, input.api]);

  const start = async (provider: string) => {
    const { api, parentSessionId } = latest.current;
    if (!api || !parentSessionId || attemptRef.current || requestRef.current || blocksAuxiliaryLaunchRetry(status)) return;
    const attempt = {};
    attemptRef.current = attempt;
    setStarting(true);
    latest.current.onFeedback("");
    let ownRequest: AuxiliaryCreationRequest | null = null;
    const isAttemptCurrent = () => mounted.current && attemptRef.current === attempt
      && latest.current.parentSessionId === parentSessionId && latest.current.api === api;
    try {
      const creationContext = await api.getAuxiliaryCreationContext(parentSessionId);
      if (!isAttemptCurrent()) return;
      ownRequest = { parentSessionId, clientRequestId: crypto.randomUUID(), creationContext };
      requestRef.current = ownRequest;
      setRequest(ownRequest);
      setStatus("preparing");
      try { window.localStorage.setItem(storageKey(parentSessionId), JSON.stringify(ownRequest)); } catch { /* Reopen hint only. */ }
      latest.current.onDiagnostic?.(ownRequest, "request");
      const saved = await api.createAuxiliarySession(buildCreateAuxiliarySessionInput({
        parentSessionId, provider, runtimeSelection: "latest-session",
        clientRequestId: ownRequest.clientRequestId, creationContext,
      }));
      if (isCurrent(ownRequest) && matchesAuxiliaryLaunchCreationRequest(saved, ownRequest)) {
        finish(ownRequest, "committed", saved);
      } else {
        latest.current.onDiagnostic?.(ownRequest, "stale-drop");
      }
    } catch (error) {
      if (!isAttemptCurrent()) return;
      if (ownRequest) {
        // A rejected create may already have committed. Query the same ID;
        // never replace it with another create request automatically.
        setStatus("unknown");
        latest.current.onFeedback(resolveAuxiliaryLaunchCreationFeedback({ status: "unknown" }));
      } else {
        setStatus("failed");
        latest.current.onFeedback(error instanceof Error ? error.message : "Auxiliary Session の開始に失敗したよ。");
      }
    } finally {
      if (isAttemptCurrent()) {
        attemptRef.current = null;
        setStarting(false);
      }
    }
  };

  const cancel = async () => {
    const candidate = requestRef.current;
    const api = latest.current.api;
    if (!candidate || !api || cancellingRef.current || !canCancelAuxiliaryLaunchCreation(status)) return;
    cancellingRef.current = candidate;
    setCancelling(true);
    try {
      const result = await reconcileAuxiliaryLaunchCreation({
        request: candidate,
        getCreation: (current) => api.cancelAuxiliaryCreation(current),
        getSession: (id) => api.getAuxiliarySession(id),
        isCurrent,
        onStatus: (nextStatus) => setStatus(nextStatus),
        onCommittedSession: (session) => finish(candidate, "committed", session),
      });
      if (!result.stale && isTerminal(result.status)) finish(candidate, result.status);
    } catch (error) {
      if (isCurrent(candidate)) latest.current.onFeedback(error instanceof Error ? error.message : "Auxiliary Session の作成を取り消せなかったよ。");
    } finally {
      if (cancellingRef.current === candidate) {
        cancellingRef.current = null;
        if (isCurrent(candidate)) setCancelling(false);
      }
    }
  };

  const inFlight = starting || request !== null || blocksAuxiliaryLaunchRetry(status);
  return { status, starting, inFlight, cancelling, start, cancel };
}
