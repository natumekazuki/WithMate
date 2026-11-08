import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionTurnQueueReceipt, SessionTurnQueueOrigin } from "../../../src-shared/session/session-turn-queue.js";
import type { SessionTarget } from "../../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { ButtonContent } from "../../ui/button-content.js";
import { ErrorDetailsButton } from "../../ui/error-details.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";

const deliveryLabels = {
  pending: "Input Acceptance Pending",
  confirmed: "Additional Input Confirmed",
  unknown: "Input Delivery Unknown",
  "not-sent": "Input Not Sent",
} as const;

export function getQueuedSourceWaitState(receipt?: SessionTurnQueueReceipt): "waiting" | "unknown" | null {
  const origin = receipt?.accepted?.origin ?? receipt?.captured.origin;
  if (receipt?.state !== "queued" || origin?.deliveryTiming !== "after_source_turn") return null;
  const phase = receipt.sourceTurnPhase;
  if (phase === undefined || phase === "unknown") return "unknown";
  return receipt.sourceTurnPendingRelease || phase === "running" ? "waiting" : null;
}

export type TurnInputReadContext = { ownerSessionId: string; target: SessionTarget };
type InputDetail = Extract<SessionExecutionReadResult<"get_execution_input">, { ok: true }>;
type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;
type InputList = Extract<SessionExecutionReadResult<"list_execution_inputs">, { ok: true }>;
type InputReference = { receiptId: string; turnId?: never } | { turnId: string; receiptId?: never };

export function InputDetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="check-item"><dt><span>{label}</span></dt><dd><strong>{children}</strong></dd></div>;
}

export function inputDetailStateLabel(value: string | null | undefined, fallback: string) {
  return value ? value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

function ComparedText({ text, other, original }: { text: string; other: string; original: boolean }) {
  let start = 0;
  while (start < text.length && start < other.length && text[start] === other[start]) ++start;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) --start;
  let end = text.length;
  let otherEnd = other.length;
  while (end > start && otherEnd > start && text[end - 1] === other[otherEnd - 1]) { --end; --otherEnd; }
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) ++end;
  return <>{text.slice(0, start)}{original ? <del>{text.slice(start, end)}</del> : <ins>{text.slice(start, end)}</ins>}{text.slice(end)}</>;
}

function InputSnapshot({ context, reference, seq, onSnapshot }: { context: TurnInputReadContext; reference: InputReference; seq?: number; onSnapshot?: (detail: InputDetail) => void }) {
  const [detail, setDetail] = useState<InputDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const identity = JSON.stringify([context, reference, seq]);
  const load = async (previous: InputDetail | null) => {
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved input reads are unavailable."); return; }
    const current = ++attempt.current;
    setBusy(true); setError("");
    const originalNext = previous?.inputPair.original?.nextOffset;
    const comparisonNext = previous?.inputPair.comparison?.nextOffset;
    const offset = Math.min(...[originalNext, comparisonNext].filter((value): value is number => value != null));
    try {
      const result = await api.readSessionExecution(context.ownerSessionId, "get_execution_input", {
        target: context.target, ...reference, ...(seq !== undefined ? { seq } : {}),
        ...(previous ? { offset, expectedInput: previous.expectedInput, stage: originalNext === offset ? "original" as const : "comparison" as const } : {}),
      });
      if (attempt.current !== current) return;
      if (!result.ok) { setError(result.message); return; }
      onSnapshot?.(result);
      const merge = (next: InputDetail["inputPair"]["original"], before: InputDetail["inputPair"]["original"]) => next && before ? { ...next, text: before.text + next.text.slice(Math.max(0, before.text.length - next.offset)), offset: 0 } : next;
      setDetail(previous ? { ...result, inputPair: { original: merge(result.inputPair.original, previous.inputPair.original), comparison: merge(result.inputPair.comparison, previous.inputPair.comparison) } } : result);
    } catch (failure) {
      if (attempt.current === current) setError(failure instanceof Error ? failure.message : "Could not read saved input.");
    } finally { if (attempt.current === current) setBusy(false); }
  };
  useEffect(() => { setDetail(null); void load(null); return () => { ++attempt.current; }; }, [identity]);
  const original = detail?.inputPair.original;
  const comparison = detail?.inputPair.comparison;
  const more = original?.nextOffset != null || comparison?.nextOffset != null;
  return <div aria-busy={busy || undefined}>
    {busy ? <LoadingIndicator inline label="Loading saved input" /> : null}
    {error ? <p role="alert">{error} <button type="button" className="drawer-toggle compact secondary" disabled={busy} onClick={() => void load(null)}>Reload Input</button></p> : null}
    {detail ? <>
      {detail.inputs.entry?.stage !== "planned" ? <p>{detail.inputs.entry?.stage === "fixed" ? "Fixed Input — Provider Delivery Is Separate" : "Input Was Not Confirmed Fixed"}</p> : null}
      <section className="artifact-section compact" aria-label="Input Comparison">
      <div className="artifact-section-header"><strong>Input Comparison</strong></div>
      <div className="turn-input-comparison">
        {([{ label: "Original Input", value: original }, { label: detail.inputs.entry?.stage === "planned" ? "Planned Input" : "Comparison Input", value: comparison }] as const).map(({ label, value }) => <section key={label}>
          <h4>{label}</h4>
          {value ? <><pre>{!more && original && comparison ? <ComparedText text={value.text} other={label === "Original Input" ? comparison.text : original.text} original={label === "Original Input"} /> : value.text}</pre>{value.attachments.length ? <ul aria-label={`${label} Attachments`}>{value.attachments.map((attachment) => <li key={attachment.id}>{attachment.kind}: {attachment.name} <code>{attachment.reference}</code></li>)}</ul> : null}</> : <p>Not Recorded</p>}
        </section>)}
      </div>
      </section>
      {more ? <button type="button" className="drawer-toggle compact secondary" disabled={busy || !!error} onClick={() => void load(detail)}>Load More Input</button> : null}
    </> : null}
  </div>;
}

type TurnInputProps = { message: Message; receipt?: SessionTurnQueueReceipt; context?: TurnInputReadContext };

export function useTurnInputRead({ message, receipt, context }: TurnInputProps) {
  const input = message.turnInput;
  const [execution, setExecution] = useState<Execution | null>(null);
  const [snapshot, setSnapshot] = useState<InputDetail | null>(null);
  const [readError, setReadError] = useState("");
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const receiptId = receipt?.id ?? input?.queueId;
  const reference: InputReference | null = receiptId ? { receiptId } : input ? { turnId: input.turnId } : null;
  const statusReference = reference ?? (message.historyIndex !== undefined ? { messageSeq: message.historyIndex } : null);
  const referenceIdentity = JSON.stringify([context, statusReference]);
  const loadedReference = useRef(referenceIdentity);
  const identity = JSON.stringify([context, statusReference, receipt?.updatedAt, input?.state, revision]);
  useEffect(() => {
    const api = getWithMateApi();
    if (!context || message.role !== "user") return;
    const refresh = (sessionId: string) => { if (sessionId === context.target.sessionId) setRevision((value) => value + 1); };
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => { queueChanged?.(); turnUpdated?.(); };
  }, [context?.target.sessionId, context?.ownerSessionId, message.role]);
  useEffect(() => {
    if (loadedReference.current !== referenceIdentity) { setExecution(null); loadedReference.current = referenceIdentity; }
    setSnapshot(null); setReadError("");
    const api = getWithMateApi();
    if (message.role !== "user" || !context || !statusReference || !api?.readSessionExecution) return;
    let active = true;
    void api.readSessionExecution(context.ownerSessionId, "get_execution", { target: context.target, ...statusReference }).then((result) => {
      if (!active) return;
      if (result.ok) setExecution(result); else setReadError(result.message);
    }).catch((error) => { if (active) setReadError(error instanceof Error ? error.message : "Could not read saved input."); });
    return () => { active = false; };
  }, [identity]);
  const observed = loadedReference.current === referenceIdentity ? snapshot ?? execution : null;
  const origin = observed?.origin ?? receipt?.accepted?.origin ?? receipt?.captured.origin;
  return { input, observed, origin, statusReference, receiptId, identity, open, setOpen, setSnapshot, readError, setReadError, setRevision };
}

export function TurnInputDetails(props: TurnInputProps) {
  return <TurnInputDetailsContent {...props} read={useTurnInputRead(props)} />;
}

export function TurnInputReadBoundary({ children, ...props }: TurnInputProps & { children: (read: ReturnType<typeof useTurnInputRead>) => ReactNode }) {
  return children(useTurnInputRead(props));
}

export function TurnInputOriginAvatar({ read }: { read: ReturnType<typeof useTurnInputRead> }) {
  const origin = read.origin;
  if (origin?.kind !== "session") return null;
  const character = origin.actorSnapshot?.character ?? { name: "Unknown Sender", iconPath: "" };
  return <><div className="message-avatar-stack">
    <CharacterAvatar character={character} size="small" className="message-avatar" />
    <button type="button" className="artifact-toggle artifact-toggle-icon" aria-label={read.open ? "Hide Input Details" : "Show Input Details"} title="Input Details" aria-expanded={read.open} onClick={() => read.setOpen(!read.open)}>{read.open ? "−" : "i"}</button>
  </div><div className="message-character-name">{character.name}</div></>;
}

export function SessionOriginRoute({ origin, target, onError }: { origin: SessionTurnQueueOrigin; target?: SessionTarget; onError: (message: string) => void }) {
  const outbound = target !== undefined;
  const snapshot = outbound ? origin.targetSnapshot : origin.actorSnapshot;
  const route = target ? target.kind === "auxiliary" ? [target.mainSessionId, target.sessionId] as const : [target.sessionId] as const : origin.actorKind === "auxiliary"
    ? origin.actorMainSessionId && origin.actorSessionId ? [origin.actorMainSessionId, origin.actorSessionId] as const : null
    : origin.actorSessionId ? [origin.actorSessionId] as const : null;
  return <button type="button" className="related-session-route" disabled={!route || !getWithMateApi()?.openSession}
    title={outbound ? "Recipient Session" : "Open Sender"} aria-label={outbound ? "Recipient Session" : `Open Sender: ${snapshot?.sessionTitle ?? "Unknown Session"}`}
    onClick={() => { if (route) void getWithMateApi()!.openSession(route[0], route[1]).catch((failure) => onError(failure instanceof Error ? failure.message : "Could not open sender Session.")); }}>
    {outbound ? <><span aria-hidden="true">@</span><span className="related-session-character">{snapshot?.character.name ?? "Unknown Recipient"}</span><span aria-hidden="true">·</span></> : null}
    <span className="related-session-title">{snapshot?.sessionTitle ?? "Unknown Session"}</span>
  </button>;
}

export function TurnInputDetailsContent({ message, receipt, context, read, compact = false }: TurnInputProps & { read: ReturnType<typeof useTurnInputRead>; compact?: boolean }) {
  const { input, observed, origin, statusReference, receiptId, identity, open, setOpen, setSnapshot, readError, setReadError, setRevision } = read;
  if (message.role !== "user" || (!statusReference && !input) || (!input && origin?.kind !== "session" && !context)) return null;
  const summary = observed?.inputs;
  const resolvedReceiptId = receiptId ?? observed?.receiptId;
  const resolvedTurnId = input?.turnId ?? receipt?.turnId ?? observed?.turnId;
  const detailReference: InputReference | null = resolvedReceiptId ? { receiptId: resolvedReceiptId } : resolvedTurnId ? { turnId: resolvedTurnId } : null;
  const entrySummary = summary?.entry ? `${summary.entry.kind === "additional" ? "Additional" : "Start"} Input · ${summary.entry.comparison === "changed" ? "Changed From Original" : summary.entry.comparison === "unchanged" ? "Unchanged From Original" : "Comparison Unknown"}` : null;
  const additionalSummary = summary ? `${summary.additional.confirmedCount} Confirmed Additional Inputs${summary.additional.unresolvedCount ? ` · ${summary.additional.unresolvedCount} Unresolved` : ""}${summary.additional.coverage === "unknown" ? " · Input Coverage Unknown" : ""}` : null;
  const sourceWaitState = getQueuedSourceWaitState(receipt);
  const hasReferences = resolvedReceiptId || resolvedTurnId || input?.nativeTurnId || origin?.kind === "session";
  const panel = <div className="artifact-block turn-input-panel">
      {compact ? <div className="artifact-section-header"><strong>Input Details</strong></div> : null}
      <dl className="check-list turn-input-rows" aria-label="Input State">
        {sourceWaitState ? <InputDetailRow label="Delivery"><span className="turn-input-state">{sourceWaitState === "waiting" ? "Waiting For Sender Turn" : "Source Turn State Unknown"}</span></InputDetailRow> : null}
        {observed || receipt ? <><InputDetailRow label="Receipt State">{inputDetailStateLabel(observed?.receiptState ?? receipt?.state, "No Receipt")}</InputDetailRow><InputDetailRow label="Turn State">{inputDetailStateLabel(observed?.turnState, "Not Confirmed")}</InputDetailRow></> : null}
        {origin?.kind === "session" ? <InputDetailRow label="Delivery Timing">{origin.deliveryTiming === "after_source_turn" ? "After Sender Turn" : "Immediate"}</InputDetailRow> : null}
        {origin?.kind === "session" && origin.sourceTurnPhase ? <InputDetailRow label="Sender Turn Outcome">{inputDetailStateLabel(origin.sourceTurnPhase, "Not Confirmed")}</InputDetailRow> : null}
        {entrySummary ? <InputDetailRow label="Input">{entrySummary}</InputDetailRow> : null}
        {additionalSummary ? <InputDetailRow label="Additional Inputs">{additionalSummary}</InputDetailRow> : null}
      </dl>
      {summary?.entry?.kind === "additional" ? <p>Start Input · {summary.startChanged === null ? "Comparison Unknown" : summary.startChanged ? "Changed From Original" : "Unchanged From Original"}</p> : null}
      {summary?.additional.notSentCount ? <p>{summary.additional.notSentCount} Inputs Not Sent · Excluded From Confirmed Inputs</p> : null}
      {input?.state === "pending" ? <p>Acceptance and saving have not been confirmed.</p> : null}
      {input?.state === "unknown" ? <p>Delivery or saving could not be confirmed. This input is not a confirmed addition.</p> : null}
      {input?.state === "not-sent" ? <p>This input was not delivered to the Turn. It has not been sent as a new Turn.</p> : null}
      {input?.state === "confirmed" && receipt ? <p>This receipt delivered additional input. Its completion does not mean the Turn has ended.</p> : null}
      {readError ? <p role="alert">{readError} <button type="button" className="drawer-toggle compact secondary" onClick={() => setRevision((value) => value + 1)}>Retry Input Details</button></p> : null}
      {open && context && detailReference && (resolvedReceiptId || message.historyIndex !== undefined) ? <InputSnapshot key={`${identity}:entry`} context={context} reference={detailReference} seq={!resolvedReceiptId ? message.historyIndex : undefined} onSnapshot={setSnapshot} /> : null}
      {open && input && !receiptId && message.historyIndex === undefined ? <p>The exact saved input reference is not yet available.</p> : null}
      {open && context && detailReference && summary ? <InputReferences key={`${identity}:${JSON.stringify(summary.additional)}`} context={context} reference={resolvedTurnId ? { turnId: resolvedTurnId } : detailReference} additional={summary.additional} /> : null}
      {hasReferences ? <details className="artifact-fold" aria-label="References">
        <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>References</strong></span></summary>
        <dl className="check-list turn-input-rows artifact-fold-body" aria-label="Input References">
          {resolvedReceiptId ? <InputDetailRow label="Receipt"><code>{resolvedReceiptId}</code></InputDetailRow> : null}
          {resolvedTurnId ? <InputDetailRow label="WithMate Turn"><code>{resolvedTurnId}</code></InputDetailRow> : null}
          {input?.nativeTurnId ? <InputDetailRow label="Provider Turn"><code>{input.nativeTurnId}</code></InputDetailRow> : null}
          {origin?.kind === "session" ? <><InputDetailRow label="Sender Session"><code>{origin.actorSessionId}</code></InputDetailRow><InputDetailRow label="Sender Incarnation"><code>{origin.actorIncarnationId}</code></InputDetailRow><InputDetailRow label="Sender Turn"><code>{origin.actorTurnId}</code></InputDetailRow><InputDetailRow label="Target Session"><code>{origin.targetSessionId}</code></InputDetailRow></> : null}
        </dl>
      </details> : null}
    </div>;
  return <>
    {compact && input ? <p className="turn-input-state" role={input.state === "pending" ? "status" : undefined}>{deliveryLabels[input.state]}</p> : null}
    <section className={`turn-input-details${compact ? " is-origin-details" : ""}`} aria-label="Input Details" hidden={compact && !open}>
    {!compact && origin?.kind === "session" ? <SessionOriginRoute origin={origin} onError={setReadError} /> : null}
    {!compact && input ? <p className="turn-input-state" role={input.state === "pending" ? "status" : undefined}>{deliveryLabels[input.state]}</p> : null}
    {!open && entrySummary ? <p className="turn-input-summary">{entrySummary}</p> : null}
    {!open && additionalSummary ? <p className="turn-input-summary">{additionalSummary}</p> : null}
    {compact ? open ? panel : null : <details className="artifact-fold" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Input Details</strong></span></summary>
      {panel}
    </details>}
  </section></>;
}

function AdditionalInput({ context, reference, seq }: { context: TurnInputReadContext; reference: InputReference; seq?: number }) {
  const [show, setShow] = useState(false);
  return show ? <InputSnapshot context={context} reference={reference} seq={seq} /> : <button type="button" className="drawer-toggle compact secondary" onClick={() => setShow(true)}>Read Saved Input</button>;
}

function InputReferences({ context, reference, additional }: { context: TurnInputReadContext; reference: InputReference; additional: Execution["inputs"]["additional"] }) {
  return <>
    <InputReferenceList context={context} reference={reference} state="confirmed" initial={additional.references.map(({ seq }) => ({ seq, state: "confirmed" }))} nextOffset={additional.referencesNextOffset} />
    <InputReferenceList context={context} reference={reference} state="unresolved" initial={additional.unresolved.map(({ receiptId, ...item }) => ({ ...item, queueId: receiptId }))} nextOffset={additional.unresolvedNextOffset} />
    <InputReferenceList context={context} reference={reference} state="not-sent" initial={additional.notSent.map(({ seq }) => ({ seq, state: "not-sent" }))} nextOffset={additional.notSentNextOffset} />
  </>;
}

type ListedInput = Pick<InputList["items"][number], "seq" | "state" | "queueId">;
function InputReferenceList({ context, reference, state, initial, nextOffset }: { context: TurnInputReadContext; reference: InputReference; state: "confirmed" | "unresolved" | "not-sent"; initial: ListedInput[]; nextOffset: number | null }) {
  const [items, setItems] = useState(initial);
  const [next, setNext] = useState(nextOffset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const label = state === "confirmed" ? "Confirmed Inputs" : state === "unresolved" ? "Unresolved Inputs" : "Not Sent Inputs";
  const load = async () => {
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved input reads are unavailable."); return; }
    if (next == null || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.readSessionExecution(context.ownerSessionId, "list_execution_inputs", { target: context.target, ...reference, state, offset: next, limit: 100 });
      if (!active.current) return;
      if (!result.ok) { setError(result.message); return; }
      setItems((before) => [...before, ...result.items.filter((item) => item.kind === "additional")]);
      setNext(result.nextOffset);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "Could not read saved inputs.");
    } finally { if (active.current) setBusy(false); }
  };
  if (!items.length && next == null) return null;
  return <section className="artifact-section compact" aria-label={label} aria-busy={busy || undefined}>
    <div className="artifact-section-header"><strong>{label}</strong></div>
    <ul className="turn-input-list" aria-label={label}>{items.map((item, index) => <li className="artifact-operation-item" key={item.queueId ?? item.seq ?? index}>
      <details className="artifact-operation-fold">
        <summary className="artifact-operation-summary">{item.state && item.state !== "confirmed" ? deliveryLabels[item.state] : "Additional Input"} · {item.seq !== null ? `Message ${item.seq}` : `Receipt ${item.queueId ?? "Reference Unknown"}`}</summary>
        <div className="artifact-operation-body">
        {item.seq !== null || item.queueId ? <AdditionalInput context={context} reference={item.queueId ? { receiptId: item.queueId } : reference} seq={item.queueId ? undefined : item.seq ?? undefined} /> : <p>The exact saved input reference is not yet available.</p>}
        </div>
      </details>
    </li>)}</ul>
    {busy ? <span role="status" className="visually-hidden">Loading {label}</span> : null}
    {error ? <p role="alert">Could Not Read {label} <ErrorDetailsButton message={error} label={`${label} Read Error Details`} /></p> : null}
    {next != null ? <button type="button" className="drawer-toggle compact secondary" disabled={busy} aria-busy={busy || undefined} onClick={() => void load()}><ButtonContent busy={busy}>{error ? `Retry ${label}` : `Load More ${label}`}</ButtonContent></button> : null}
  </section>;
}
