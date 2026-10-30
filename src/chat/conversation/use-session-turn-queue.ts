import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { SessionTurnSubmission } from "../runtime/session-turn-submissions.js";

export type SessionTurnQueueApi = Partial<Pick<WithMateWindowApi, "listSessionTurnQueue" | "getSessionTurnQueueReceipt" | "listSessionTurnQueueReceipts" | "onSessionTurnQueueChanged" | "cancelQueuedSessionTurn" | "releaseInterruptedSessionTurn" | "sendQueuedSessionInput" | "reorderQueuedSessionTurns">>;
const EMPTY_RECEIPTS: SessionTurnQueueReceipt[] = [];
type QueueState = {
  owner: string; active: SessionTurnQueueReceipt[]; bridges: SessionTurnQueueReceipt[]; error: string; loading: boolean; ready: boolean;
  reconciledHistory?: { canonicalSignature: string; submissionSignature: string };
};
export type SessionTurnQueueActionKind = "cancel" | "release" | "input" | "move-up" | "move-down";
export type SessionTurnQueueMoveDirection = "up" | "down";
type QueueAction = { owner: string; id: string; kind: SessionTurnQueueActionKind };

export function useSessionTurnQueue(api: SessionTurnQueueApi | undefined, sessionId: string, incarnationId: string, enabled: boolean, canonicalUserSeqs: readonly number[] = [], submissions: readonly SessionTurnSubmission[] = []) {
  const owner = `${sessionId}:${incarnationId}`;
  const [state, setState] = useState<QueueState>({ owner, active: [], bridges: [], error: "", loading: true, ready: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const canonicalRef = useRef(new Set(canonicalUserSeqs));
  canonicalRef.current = new Set(canonicalUserSeqs);
  const canonicalSignature = canonicalUserSeqs.join(",");
  const submissionsRef = useRef(submissions);
  submissionsRef.current = submissions;
  const submissionSignature = submissions.map((submission) => `${submission.requestId}:${submission.receipt?.updatedAt ?? ""}`).join(",");
  const [revision, setRevision] = useState(0);
  const [pendingAction, setPendingAction] = useState<QueueAction | null>(null);
  const [actionError, setActionError] = useState<{ owner: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState<{ owner: string; message: string } | null>(null);
  const actionRef = useRef<QueueAction | null>(null);
  const generation = useRef(0);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  const observedCanonical = useRef({ owner, signature: canonicalSignature });
  useEffect(() => { setPendingAction(null); }, [owner]);
  useEffect(() => {
    const previous = observedCanonical.current;
    observedCanonical.current = { owner, signature: canonicalSignature };
    if (!enabled || previous.owner !== owner || previous.signature === canonicalSignature) return;
    const known = stateRef.current.owner === owner ? [...stateRef.current.active, ...stateRef.current.bridges] : [];
    // Canonical-first delivery must still resolve a local request whose receipt has not bound its user seq.
    if (submissionsRef.current.some((submission) => canonicalUserSeqs.some((seq) => seq >= submission.historyMessageCount)
      && submission.receipt?.userMessageSeq == null && !known.some((receipt) => receipt.requestId === submission.requestId && receipt.userMessageSeq !== null))) reload();
  }, [owner, enabled, canonicalSignature, reload]);
  useEffect(() => {
    setState((current) => {
      if (current.owner !== owner) return current;
      const bridges = current.bridges.filter((receipt) => submissionsRef.current.some((submission) => submission.requestId === receipt.requestId)
        || receipt.userMessageSeq === null || !canonicalRef.current.has(receipt.userMessageSeq));
      return bridges.length === current.bridges.length ? current : { ...current, bridges };
    });
  }, [owner, canonicalSignature, submissionSignature]);
  useEffect(() => {
    if (!enabled || !api?.listSessionTurnQueue) return;
    const request = ++generation.current;
    const previous = stateRef.current.owner === owner ? stateRef.current : null;
    // A receipt read can reconcile only the history/submissions observed before it began.
    const reconciledHistory = { canonicalSignature, submissionSignature };
    const requestedSubmissions = submissionsRef.current;
    setState((current) => current.owner === owner ? { ...current, error: "", loading: !current.ready }
      : { owner, active: [], bridges: [], error: "", loading: true, ready: false });
    void (async () => {
      const active = (await api.listSessionTurnQueue!(sessionId)).filter((receipt) => receipt.sessionId === sessionId && receipt.incarnationId === incarnationId);
      const bridges = [...(previous?.bridges ?? [])];
      let canReconcileHistory = true;
      // Local sends may finish before the first active-queue snapshot reaches this column.
      for (const submission of requestedSubmissions) {
        if (active.some((receipt) => receipt.requestId === submission.requestId)) continue;
        if (!api.getSessionTurnQueueReceipt) { canReconcileHistory = false; continue; }
        const receipt = await api.getSessionTurnQueueReceipt(sessionId, submission.requestId);
        if (!receipt || receipt.sessionId !== sessionId || receipt.incarnationId !== incarnationId) continue;
        if (receipt.state === "queued" || receipt.state === "starting" || receipt.state === "running") active.push(receipt);
        else bridges.push(receipt);
      }
      const missingTurns = (previous?.active ?? []).filter((receipt) => (receipt.state === "queued" || receipt.state === "starting" || receipt.state === "running") && !active.some((candidate) => candidate.id === receipt.id));
      for (const missing of missingTurns) {
        if (!api.getSessionTurnQueueReceipt) throw new Error("Could not resolve the finished turn's receipt.");
        const terminal = await api.getSessionTurnQueueReceipt(sessionId, missing.requestId);
        if (!terminal || terminal.sessionId !== sessionId || terminal.incarnationId !== incarnationId || terminal.id !== missing.id) throw new Error("The finished turn's receipt could not be confirmed. Retry Queue.");
        if (terminal.state !== "canceled" || terminal.userMessageSeq !== null) bridges.push(terminal);
      }
      if (generation.current !== request) return;
      const retained = bridges.filter((receipt) => !active.some((candidate) => candidate.id === receipt.id)
        && (submissionsRef.current.some((submission) => submission.requestId === receipt.requestId)
          || receipt.userMessageSeq === null || !canonicalRef.current.has(receipt.userMessageSeq)));
      setState({ owner, active, bridges: [...new Map(retained.map((receipt) => [receipt.id, receipt])).values()], error: "", loading: false, ready: true,
        reconciledHistory: canReconcileHistory ? reconciledHistory : undefined });
    })().catch((error) => {
      if (generation.current === request) setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error), loading: false }));
    });
    return () => { ++generation.current; };
  }, [api, owner, enabled, revision, submissionSignature]);
  useEffect(() => {
    if (!enabled) return;
    return api?.onSessionTurnQueueChanged?.((changedId) => { if (changedId === sessionId) reload(); });
  }, [api, enabled, sessionId, reload]);
  const act = useCallback(async (receipt: SessionTurnQueueReceipt, kind: SessionTurnQueueActionKind, expectedTurnId?: string, order?: { expectedQueuedIds: string[]; queuedIds: string[] }) => {
    if (receipt.sessionId !== sessionId || receipt.incarnationId !== incarnationId) return;
    if (actionRef.current?.owner === owner) return;
    const action = { owner, id: receipt.id, kind };
    actionRef.current = action;
    setPendingAction(action);
    setActionError(null);
    setAnnouncement(null);
    try {
      if (kind === "move-up" || kind === "move-down") {
        if (!order || !api?.reorderQueuedSessionTurns) throw new Error("Queue reordering is unavailable.");
        const result = await api.reorderQueuedSessionTurns(sessionId, { incarnationId, ...order });
        if (currentOwner.current === owner) {
          // A pre-mutation read must not replace the confirmed order.
          ++generation.current;
          const positions = new Map(result.receipts.filter((item) => item.state === "queued").map((item) => [item.id, item.queuePosition]));
          setState((current) => current.owner !== owner ? current : {
            ...current, active: current.active.map((item) => item.state === "queued" && positions.has(item.id) ? { ...item, queuePosition: positions.get(item.id)! } : item),
          });
          if (result.outcome === "conflict") setActionError({ owner, message: "The queue changed before the move was saved." });
          else setAnnouncement({ owner, message: `Queue order saved. Message moved to position ${order.queuedIds.indexOf(receipt.id) + 1} of ${order.queuedIds.length}.` });
        }
      } else if (kind === "input") {
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
        const message = error instanceof Error ? error.message : String(error);
        setActionError({ owner, message: kind === "move-up" || kind === "move-down"
          ? `The queue move could not be confirmed. Check the refreshed order before trying again. ${message}` : message });
      }
    } finally {
      if (actionRef.current === action) actionRef.current = null;
      if (currentOwner.current === owner) setPendingAction(null);
    }
  }, [api, owner, sessionId, incarnationId, reload]);
  const retry = useCallback(() => { setActionError(null); reload(); }, [reload]);
  const cancel = useCallback((receipt: SessionTurnQueueReceipt) => void act(receipt, "cancel"), [act]);
  const release = useCallback((receipt: SessionTurnQueueReceipt) => void act(receipt, "release"), [act]);
  const sendInput = useCallback((receipt: SessionTurnQueueReceipt, expectedTurnId: string) => void act(receipt, "input", expectedTurnId), [act]);
  const receipts = useMemo(() => {
    if (!enabled) return EMPTY_RECEIPTS;
    const known = state.owner === owner ? [...state.active, ...state.bridges] : [];
    return [...known, ...submissions.flatMap((submission) => submission.receipt && !known.some((receipt) => receipt.requestId === submission.requestId) ? [submission.receipt] : [])];
  }, [enabled, state.owner, owner, state.active, state.bridges, submissions]);
  const queuedReceipts = useMemo(() => receipts.filter((receipt) => receipt.state === "queued").sort((left, right) => left.queuePosition - right.queuePosition), [receipts]);
  const move = useCallback((receipt: SessionTurnQueueReceipt, direction: SessionTurnQueueMoveDirection) => {
    const expectedQueuedIds = queuedReceipts.map((item) => item.id);
    const index = expectedQueuedIds.indexOf(receipt.id);
    const destination = index + (direction === "up" ? -1 : 1);
    if (index < 0 || destination < 0 || destination >= expectedQueuedIds.length) return;
    const queuedIds = [...expectedQueuedIds];
    [queuedIds[index], queuedIds[destination]] = [queuedIds[destination], queuedIds[index]];
    void act(receipt, direction === "up" ? "move-up" : "move-down", undefined, { expectedQueuedIds, queuedIds });
  }, [act, queuedReceipts]);
  return {
    historyReconciled: state.owner === owner && state.reconciledHistory?.canonicalSignature === canonicalSignature
      && state.reconciledHistory.submissionSignature === submissionSignature,
    receipts, queuedReceipts, announcement: enabled && announcement?.owner === owner ? announcement.message : "",
    error: enabled ? [actionError?.owner === owner ? actionError.message : "",
      state.owner === owner && state.error ? (state.ready ? `Queue refresh failed. The displayed queue may be out of date. ${state.error}` : state.error) : "",
    ].filter(Boolean).join(" ") : "",
    loading: enabled && !!api?.listSessionTurnQueue && (state.owner !== owner || state.loading),
    busyId: pendingAction?.owner === owner ? pendingAction.id : null,
    busyKind: pendingAction?.owner === owner ? pendingAction.kind : null,
    reload: retry, cancel, release, sendInput, move,
  };
}
