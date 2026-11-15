import { useEffect, useState } from "react";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { LoadError } from "../ui/load-error.js";

type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;

export function receiptStateLabel(state: string | null) {
  return ({ queued: "Queued", starting: "Starting", running: "In Progress", completed: "Completed", failed: "Failed", canceled: "Canceled", interrupted: "Interrupted — Outcome Unknown" })[state ?? ""] ?? "Unknown";
}

export function CoordinationAnswerDelivery({ ownerSessionId, target, receiptId, acquired, consumed, active = true, onDeliveryChange }: {
  ownerSessionId: string;
  target?: SessionTarget;
  receiptId?: string;
  acquired?: boolean;
  consumed?: boolean;
  active?: boolean;
  onDeliveryChange?: () => void;
}) {
  const [state, setState] = useState<{ key: string; result: Execution | null; error: string; loading: boolean }>({ key: "", result: null, error: "", loading: false });
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([ownerSessionId, target, receiptId]);
  const result = state.key === identity ? state.result : null;
  const error = state.key === identity ? state.error : "";
  const loading = state.key === identity && state.loading;

  useEffect(() => {
    if (!active || !receiptId) return;
    let current = true;
    setState((previous) => ({ key: identity, result: previous.key === identity ? previous.result : null, error: "", loading: true }));
    const read = async () => {
      const api = getWithMateApi();
      if (!target) throw new Error("The exact recipient reference is unavailable.");
      if (!api?.readSessionExecution) throw new Error("Saved execution reads are unavailable.");
      const next = await api.readSessionExecution(ownerSessionId, "get_execution", { target, receiptId });
      if (!current) return;
      if (!next.ok) throw new Error(next.message);
      setState({ key: identity, result: next, error: "", loading: false });
    };
    void read().catch((reason: unknown) => {
      if (current) setState((previous) => ({ ...previous, key: identity, loading: false, error: reason instanceof Error ? reason.message : "Delivery could not be confirmed." }));
    });
    return () => { current = false; };
  }, [identity, active, revision]);
  useEffect(() => {
    if (!active || !target || !receiptId) return;
    const refresh = (sessionId: string) => { if (sessionId === target.sessionId) { setRevision((value) => value + 1); onDeliveryChange?.(); } };
    const api = getWithMateApi();
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => { queueChanged?.(); turnUpdated?.(); };
  }, [identity, active, onDeliveryChange]);

  if (!receiptId) return <p className="coordination-parties" role="status">{acquired ? "Received" : "Saved · Not Sent"}{consumed ? " · Answer Used" : ""}</p>;
  const turnFailure = result && ["failed", "canceled", "interrupted"].includes(result.turnState ?? "")
    ? ` · Turn ${receiptStateLabel(result.turnState)}` : "";
  return <div className="coordination-answer-delivery" aria-busy={loading || undefined}>
    <p className="coordination-parties" role="status">
      {acquired ? `Received${turnFailure}` : error ? "Delivery Unknown" : result ? `${result.receiptState === "completed" ? "Delivered" : `Delivery ${receiptStateLabel(result.receiptState)}`}${turnFailure}` : "Checking Delivery"}
      {consumed ? " · Answer Used" : ""}
    </p>
    {error ? <LoadError message={error} onRetry={() => setRevision((value) => value + 1)} /> : null}
  </div>;
}
