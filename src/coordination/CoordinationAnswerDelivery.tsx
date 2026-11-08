import { useEffect, useState } from "react";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";

type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;
type OutputPage = Extract<SessionExecutionReadResult<"list_execution_outputs">, { ok: true }>;
type Output = Extract<SessionExecutionReadResult<"get_execution_output">, { ok: true }>;
type ReadContext = { ownerSessionId: string; target: SessionTarget; receiptId: string };

export function receiptStateLabel(state: string | null) {
  return ({ queued: "Queued", starting: "Starting", running: "In Progress", completed: "Completed", failed: "Failed", canceled: "Canceled", interrupted: "Interrupted — Outcome Unknown" })[state ?? ""] ?? "Unknown";
}
function turnStateLabel(state: string | null) {
  return ({ running: "Running", completed: "Completed", failed: "Failed", canceled: "Canceled", interrupted: "Interrupted" })[state ?? ""] ?? "Not Confirmed";
}

function SavedOutput({ context, index }: { context: ReadContext; index: number }) {
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState({ offset: 0, revision: 0 });
  const identity = JSON.stringify(context);
  useEffect(() => {
    let current = true;
    setBusy(true); setError("");
    const api = getWithMateApi();
    const read = async () => {
      if (!api?.readSessionExecution) throw new Error("Saved execution reads are unavailable.");
      const result = await api.readSessionExecution(context.ownerSessionId, "get_execution_output", { target: context.target, receiptId: context.receiptId, index, offset: request.offset });
      if (!current) return;
      if (!result.ok) throw new Error(result.message);
      setOutput((previous) => request.offset > 0 && previous ? { ...result, text: previous.text + result.text } : result);
    };
    void read().catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "Could not read saved output."); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [identity, index, request]);
  return <div aria-busy={busy || undefined}>
    {busy ? <LoadingIndicator inline label="Loading saved output" /> : null}
    {error ? <LoadError message={error} onRetry={() => setRequest({ offset: 0, revision: request.revision + 1 })} /> : null}
    {output ? <><p>{output.unit.final ? "Final Answer" : "Saved Output"} · {({ complete: "Complete", partial: "Partial", streaming: "Streaming", unknown: "Unknown" })[output.unit.completion]}</p><pre className="coordination-operation-feedback">{output.text}</pre>
      {output.nextOffset !== null ? <button className="drawer-toggle compact secondary" type="button" disabled={busy || !!error} onClick={() => setRequest({ offset: output.nextOffset!, revision: request.revision + 1 })}>Load More Output</button> : null}</> : null}
  </div>;
}

function SavedResult({ context }: { context: ReadContext }) {
  const [page, setPage] = useState<OutputPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [request, setRequest] = useState({ offset: 0, revision: 0 });
  const identity = JSON.stringify(context);
  useEffect(() => {
    let current = true;
    setBusy(true); setError("");
    const api = getWithMateApi();
    const read = async () => {
      if (!api?.readSessionExecution) throw new Error("Saved execution reads are unavailable.");
      const result = await api.readSessionExecution(context.ownerSessionId, "list_execution_outputs", { target: context.target, receiptId: context.receiptId, offset: request.offset, limit: 20 });
      if (!current) return;
      if (!result.ok) throw new Error(result.message);
      setPage((previous) => request.offset > 0 && previous ? { ...result, items: [...previous.items, ...result.items] } : result);
    };
    void read().catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "Could not read the saved result."); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [identity, request]);
  return <section aria-label="Recipient Turn Result" aria-busy={busy || undefined}>
    {busy ? <LoadingIndicator inline label="Loading recipient Turn result" /> : null}
    {error ? <LoadError message={error} onRetry={() => setRequest({ offset: 0, revision: request.revision + 1 })} /> : null}
    {page ? <>
      <p>{page.resultState === "partial" ? "Partial Result" : "Saved Result"} · {page.finality === "identified" ? "Final Answer Identified" : page.finality === "none" ? "No Final Answer" : "Final Answer Unknown"}</p>
      <ol>{page.items.map((unit) => <li key={`${unit.index}:${unit.id}`}><button className="drawer-toggle compact secondary" type="button" onClick={() => setSelectedIndex(unit.index)} aria-pressed={selectedIndex === unit.index}>Read {unit.final ? "Final Answer" : "Output"} {unit.index + 1}</button>{unit.phase ? ` · ${unit.phase}` : ""}</li>)}</ol>
      {page.nextOffset !== null ? <button className="drawer-toggle compact secondary" type="button" disabled={busy || !!error} onClick={() => setRequest({ offset: page.nextOffset!, revision: request.revision + 1 })}>More Outputs</button> : null}
      {selectedIndex !== null ? <SavedOutput key={`${identity}:${selectedIndex}`} context={context} index={selectedIndex} /> : null}
    </> : null}
  </section>;
}

export function CoordinationAnswerDelivery({ ownerSessionId, target, receiptId }: {
  ownerSessionId: string;
  target?: SessionTarget;
  receiptId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [state, setState] = useState<{ key: string; result: Execution | null; error: string; loading: boolean }>({ key: "", result: null, error: "", loading: false });
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([ownerSessionId, target, receiptId]);
  const result = state.key === identity ? state.result : null;
  const error = state.key === identity ? state.error : "";
  const loading = state.key === identity && state.loading;
  useEffect(() => { setResultOpen(false); }, [identity]);
  useEffect(() => {
    if (!open || !receiptId) return;
    let current = true;
    setState((previous) => ({ key: identity, result: previous.key === identity ? previous.result : null, error: "", loading: true }));
    const api = getWithMateApi();
    const read = async () => {
      if (!target) throw new Error("The exact recipient reference is unavailable.");
      if (!api?.readSessionExecution) throw new Error("Saved execution reads are unavailable.");
      const next = await api.readSessionExecution(ownerSessionId, "get_execution", { target, receiptId });
      if (!current) return;
      if (!next.ok) throw new Error(next.message);
      setState({ key: identity, result: next, error: "", loading: false });
    };
    void read().catch((reason) => { if (current) setState((previous) => ({ ...previous, key: identity, loading: false, error: reason instanceof Error ? reason.message : "Delivery could not be confirmed." })); });
    return () => { current = false; };
  }, [identity, open, revision]);
  useEffect(() => {
    if (!open || !target || !receiptId) return;
    const refresh = (sessionId: string) => { if (sessionId === target.sessionId) setRevision((value) => value + 1); };
    const api = getWithMateApi();
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => { queueChanged?.(); turnUpdated?.(); };
  }, [identity, open]);
  if (!receiptId) return <p className="coordination-parties">Saved · Not Sent</p>;
  return <details className="artifact-fold coordination-answer-delivery" aria-busy={loading || undefined} onToggle={(event) => { if (event.target === event.currentTarget) { setOpen(event.currentTarget.open); if (!event.currentTarget.open) setResultOpen(false); } }}>
    <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Saved · Delivery Details</strong></span></summary>
    {open ? <>
      {loading ? <LoadingIndicator inline label="Loading answer delivery" /> : null}
      {error ? <><p className="coordination-parties">{result ? "Delivery Refresh Failed · Last Read Below" : "Delivery Unknown"}</p><LoadError message={error} onRetry={() => setRevision((value) => value + 1)} /></> : null}
      {result ? <dl className="check-list">
        <div className="check-item"><dt>Receipt Delivery</dt><dd><strong>{receiptStateLabel(result.receiptState)}</strong></dd></div>
        <div className="check-item"><dt>Recipient Turn</dt><dd><strong>{turnStateLabel(result.turnState)}</strong></dd></div>
        <div className="check-item"><dt>Saved Result</dt><dd><strong>{({ "not-started": "Not Started", unknown: "Unknown", running: "Running", "not-saved": "Not Saved", saved: "Saved", partial: "Partial" })[result.resultState]}</strong></dd></div>
      </dl> : null}
      {result?.turnId && target ? <details onToggle={(event) => { if (event.target === event.currentTarget) setResultOpen(event.currentTarget.open); }}>
        <summary>Read Recipient Turn Result</summary>
        {resultOpen ? <SavedResult key={identity} context={{ ownerSessionId, target, receiptId }} /> : null}
      </details> : null}
    </> : null}
  </details>;
}
