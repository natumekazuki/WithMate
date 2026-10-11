import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";

export type SessionTurnQueueApi = Partial<Pick<WithMateWindowApi, "listSessionTurnQueue" | "getSessionTurnQueueReceipt" | "listSessionTurnQueueReceipts" | "onSessionTurnQueueChanged" | "cancelQueuedSessionTurn" | "releaseInterruptedSessionTurn" | "sendQueuedSessionInput">>;
const EMPTY_RECEIPTS: SessionTurnQueueReceipt[] = [];
type QueueState = { owner: string; active: SessionTurnQueueReceipt[]; bridges: SessionTurnQueueReceipt[]; error: string; loading: boolean };

export function useSessionTurnQueue(api: SessionTurnQueueApi | undefined, sessionId: string, incarnationId: string, enabled: boolean, canonicalUserSeqs: readonly number[] = []) {
  const owner = `${sessionId}:${incarnationId}`;
  const [state, setState] = useState<QueueState>({ owner, active: [], bridges: [], error: "", loading: true });
  const stateRef = useRef(state);
  stateRef.current = state;
  const canonicalRef = useRef(new Set(canonicalUserSeqs));
  canonicalRef.current = new Set(canonicalUserSeqs);
  const canonicalSignature = canonicalUserSeqs.join(",");
  const [revision, setRevision] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ owner: string; message: string } | null>(null);
  const actionRef = useRef<{ owner: string; id: string } | null>(null);
  const generation = useRef(0);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => { setBusyId(null); }, [owner]);
  useEffect(() => {
    setState((current) => {
      if (current.owner !== owner) return current;
      const bridges = current.bridges.filter((receipt) => receipt.userMessageSeq === null || !canonicalRef.current.has(receipt.userMessageSeq));
      return bridges.length === current.bridges.length ? current : { ...current, bridges };
    });
  }, [owner, canonicalSignature]);
  useEffect(() => {
    if (!enabled || !api?.listSessionTurnQueue) return;
    const request = ++generation.current;
    const previous = stateRef.current.owner === owner ? stateRef.current : null;
    setState((current) => ({ owner, active: current.owner === owner ? current.active : [], bridges: current.owner === owner ? current.bridges : [], error: "", loading: true }));
    void (async () => {
      const active = (await api.listSessionTurnQueue!(sessionId)).filter((receipt) => receipt.sessionId === sessionId && receipt.incarnationId === incarnationId);
      const bridges = [...(previous?.bridges ?? [])];
      const missingRuns = (previous?.active ?? []).filter((receipt) => (receipt.state === "starting" || receipt.state === "running") && !active.some((candidate) => candidate.id === receipt.id));
      for (const missing of missingRuns) {
        if (!api.getSessionTurnQueueReceipt) throw new Error("Could not resolve the finished turn's receipt.");
        const terminal = await api.getSessionTurnQueueReceipt(sessionId, missing.requestId);
        if (!terminal || terminal.sessionId !== sessionId || terminal.incarnationId !== incarnationId || terminal.id !== missing.id) throw new Error("The finished turn's receipt could not be confirmed. Retry Queue.");
        if (terminal.state !== "canceled" || terminal.userMessageSeq !== null) bridges.push(terminal);
      }
      if (generation.current !== request) return;
      const retained = bridges.filter((receipt) => !active.some((candidate) => candidate.id === receipt.id)
        && (receipt.userMessageSeq === null || !canonicalRef.current.has(receipt.userMessageSeq)));
      setState({ owner, active, bridges: [...new Map(retained.map((receipt) => [receipt.id, receipt])).values()], error: "", loading: false });
    })().catch((error) => {
      if (generation.current === request) setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error), loading: false }));
    });
    return () => { ++generation.current; };
  }, [api, owner, enabled, revision]);
  useEffect(() => {
    if (!enabled) return;
    return api?.onSessionTurnQueueChanged?.((changedId) => { if (changedId === sessionId) reload(); });
  }, [api, enabled, sessionId, reload]);
  const act = useCallback(async (receipt: SessionTurnQueueReceipt, kind: "cancel" | "release" | "input", expectedTurnId?: string) => {
    if (receipt.sessionId !== sessionId || receipt.incarnationId !== incarnationId) return;
    if (actionRef.current?.owner === owner) return;
    const action = { owner, id: receipt.id };
    actionRef.current = action;
    setBusyId(receipt.id);
    setActionError(null);
    try {
      if (kind === "input") {
        if (!expectedTurnId || !api?.sendQueuedSessionInput) throw new Error("Current-turn input is unavailable.");
        const accepted = await api.sendQueuedSessionInput(sessionId, receipt.id, expectedTurnId);
        if (accepted.sessionId !== sessionId || accepted.incarnationId !== incarnationId || accepted.id !== receipt.id) throw new Error("Input receipt identity changed.");
        if (currentOwner.current === owner && accepted.state === "completed") setState((current) => current.owner !== owner ? current : {
          ...current,
          active: current.active.filter((item) => item.id !== receipt.id),
          bridges: accepted.userMessageSeq !== null && !canonicalRef.current.has(accepted.userMessageSeq)
            ? [...current.bridges.filter((item) => item.id !== receipt.id), accepted] : current.bridges,
        });
      } else {
        const operation = kind === "cancel" ? api?.cancelQueuedSessionTurn : api?.releaseInterruptedSessionTurn;
        if (!operation) throw new Error("Queue action is unavailable.");
        await operation(sessionId, receipt.id);
      }
      if (currentOwner.current === owner) reload();
    } catch (error) {
      if (currentOwner.current === owner) {
        reload();
        setActionError({ owner, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (actionRef.current === action) actionRef.current = null;
      if (currentOwner.current === owner) setBusyId(null);
    }
  }, [api, owner, sessionId, incarnationId, reload]);
  const retry = useCallback(() => { setActionError(null); reload(); }, [reload]);
  const cancel = useCallback((receipt: SessionTurnQueueReceipt) => void act(receipt, "cancel"), [act]);
  const release = useCallback((receipt: SessionTurnQueueReceipt) => void act(receipt, "release"), [act]);
  const sendInput = useCallback((receipt: SessionTurnQueueReceipt, expectedTurnId: string) => void act(receipt, "input", expectedTurnId), [act]);
  const receipts = useMemo(() => enabled && state.owner === owner ? [...state.active, ...state.bridges] : EMPTY_RECEIPTS, [enabled, state.owner, owner, state.active, state.bridges]);
  return {
    receipts, error: enabled ? (actionError?.owner === owner ? actionError.message : state.owner === owner ? state.error : "") : "", loading: enabled && !!api?.listSessionTurnQueue && (state.owner !== owner || state.loading),
    busyId, reload: retry, cancel, release, sendInput,
  };
}
