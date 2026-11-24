import { useEffect, useState, type ReactNode } from "react";
import { coordinationDeliveryText, readCoordinationNotification } from "../../../src-shared/coordination/coordination-delivery.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueReceipt, SessionTurnQueueOrigin, SessionSteerOrigin } from "../../../src-shared/session/session-turn-queue.js";
import type { SessionTarget } from "../../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";
import { approvalModeLabel } from "../../../src-shared/settings/approval-mode.js";
import { reasoningEffortLabel } from "../../../src-shared/settings/model-catalog.js";
import { codexSandboxModeOptions } from "../../../src-shared/settings/codex-sandbox-mode.js";
import { getQueuedSourceWaitState } from "./queued-source-wait.js";

export type TurnInputReadContext = { ownerSessionId: string; target: SessionTarget };
type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;
type InputDisplay = Extract<SessionExecutionReadResult<"read_turn_input_display">, { ok: true }>;
type InputReference = { receiptId: string; turnId?: never } | { turnId: string; receiptId?: never };

export function InputDetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="check-item"><dt><span>{label}</span></dt><dd><strong>{children}</strong></dd></div>;
}

export function inputDetailStateLabel(value: string | null | undefined, fallback: string) {
  return value ? value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

export function retrySourceLabel(origin: SessionTurnQueueOrigin | undefined) {
  return origin ? `Retry requested by you · Previous input from ${origin.kind === "session" ? origin.actorSnapshot?.character.name ?? "Unknown Session" : "you"}` : undefined;
}

/** A card can display the previous author without changing the recorded actor. */
export function projectRetryInputAuthor(origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined,
  source: SessionTurnQueueCapturedInput["retrySource"] | null, unchanged: boolean) {
  const previous = origin?.kind === "gui" && source && source.origin.targetSessionId === origin.targetSessionId
    && source.origin.targetIncarnationId === origin.targetIncarnationId ? source : null;
  return {
    origin: previous?.changedSinceAcceptance === false && unchanged ? previous.origin : origin,
    retryLabel: retrySourceLabel(previous?.origin),
  };
}

export function retryReceiptInputUnchanged(receipt: SessionTurnQueueReceipt) {
  const comparison = (input: SessionTurnQueueCapturedInput) => JSON.stringify([input.request.userMessage,
    input.attachments.map(({ id, kind, absolutePath }) => [id, kind, absolutePath])]);
  return !!receipt.accepted && comparison(receipt.accepted) === comparison(receipt.dispatched ?? receipt.captured);
}

function ExecutionSettings({ settings }: { settings: NonNullable<Execution["executionSettings"]> }) {
  const providerLabel = ({ codex: "Codex", claude: "Claude", copilot: "Copilot", opencode: "OpenCode" } as Record<string, string>)[settings.provider] ?? settings.provider;
  const supportsReviewerAndSpeed = settings.provider === "codex" || settings.provider === "claude";
  const rows: [string, string | null][] = [
    ["provider", providerLabel], ["approval", approvalModeLabel(settings.approvalMode)],
  ];
  if (supportsReviewerAndSpeed) rows.push(["reviewer", settings.codexReviewer], ["speed", settings.codexSpeed]);
  rows.push(["model", settings.model], ["reasoning", settings.reasoningEffort ? reasoningEffortLabel(settings.reasoningEffort) : settings.source === "input" ? "Provider Default" : null]);
  if (settings.provider === "codex") rows.push(["sandbox", codexSandboxModeOptions.find((option) => option.id === settings.codexSandboxMode)?.label ?? settings.codexSandboxMode]);
  if (settings.customAgentName) rows.push(["agent", settings.customAgentName]);
  return <details className="artifact-fold" aria-label="Execution Settings" open>
    <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Execution Settings</strong></span></summary>
    <dl className="check-list turn-input-rows artifact-fold-body">
      {rows.map(([label, value]) => <InputDetailRow key={label} label={label}>{value || "Not Recorded"}</InputDetailRow>)}
    </dl>
  </details>;
}

type TurnInputProps = { message: Message; receipt?: SessionTurnQueueReceipt; context?: TurnInputReadContext; turnId?: string; active?: boolean };

export function useTurnInputRead({ message, receipt, context, turnId, active = true }: TurnInputProps, mode: "display" | "details" = "display") {
  const input = message.turnInput;
  const [loaded, setLoaded] = useState<{ key: string; display?: InputDisplay; execution?: Execution; error?: string } | null>(null);
  const [routeError, setRouteError] = useState<{ key: string; message: string }>();
  const [revision, setRevision] = useState(0);
  const receiptId = receipt?.id ?? input?.queueId;
  const reference: InputReference | null = receiptId ? { receiptId } : input || turnId ? { turnId: input?.turnId ?? turnId! } : null;
  const statusReference = input && !receiptId && message.historyIndex !== undefined
    ? { messageSeq: message.historyIndex } : reference ?? (message.historyIndex !== undefined ? { messageSeq: message.historyIndex } : null);
  const referenceIdentity = JSON.stringify([context, statusReference, mode]);
  const currentRead = active && loaded?.key === referenceIdentity ? loaded : null;
  const observed = currentRead?.display ?? null;
  const execution = currentRead?.execution ?? null;
  // A direct additional input belongs to its own sender, not the Turn's start input.
  const origin = input && !receiptId ? input.origin : observed?.origin ?? execution?.origin ?? receipt?.accepted?.origin ?? receipt?.captured.origin;
  const sourceSessionId = origin?.kind === "session" ? origin.actorSessionId : undefined;
  const sourceMainId = origin?.kind === "session" && origin.actorKind === "auxiliary" ? origin.actorMainSessionId : undefined;
  useEffect(() => {
    const api = getWithMateApi();
    if (!active || !context) return;
    const refresh = (sessionId: string) => { if (sessionId === context.target.sessionId) setRevision((value) => value + 1); };
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => { queueChanged?.(); turnUpdated?.(); };
  }, [context?.target.sessionId, context?.ownerSessionId, active]);
  useEffect(() => {
    if (!active || mode !== "display" || !sourceSessionId) return;
    return getWithMateApi()?.subscribeSessionInvalidation?.((event) => {
      // Main title, description and pin updates affect only summaries, not saved origin or color.
      if (event.detailChanged === false) return;
      if (event.scope === "ids" && !event.sessionIds.includes(sourceSessionId) && (!sourceMainId || !event.sessionIds.includes(sourceMainId))) return;
      setRevision((value) => value + 1);
    });
  }, [active, mode, sourceSessionId, sourceMainId]);
  const identity = JSON.stringify([referenceIdentity, receipt?.updatedAt, input?.state, revision]);
  useEffect(() => {
    const api = getWithMateApi();
    if (!active || !context || !statusReference || !api?.readSessionExecution) return;
    let current = true;
    setLoaded((value) => value?.key === referenceIdentity && value.error ? { ...value, error: undefined } : value);
    setRouteError((value) => value?.key === referenceIdentity ? undefined : value);
    const fail = (error: string) => setLoaded((value) => {
      if (value?.key !== referenceIdentity) return { key: referenceIdentity, error };
      const display = value.display ? { ...value.display, senderTheme: null } : undefined;
      return { ...value, display, error };
    });
    const request = { target: context.target, ...statusReference };
    const load = async () => {
      if (mode === "display") {
        const result = await api.readSessionExecution(context.ownerSessionId, "read_turn_input_display", request);
        if (!current) return;
        if (result.ok) setLoaded({ key: referenceIdentity, display: result }); else fail(result.message);
      } else {
        let result = await api.readSessionExecution(context.ownerSessionId, "get_execution", request);
        if (current && result.ok && message.role === "assistant" && !result.receiptId && result.userMessageSeq !== null) {
          result = await api.readSessionExecution(context.ownerSessionId, "get_execution", { target: context.target, messageSeq: result.userMessageSeq });
        }
        if (!current) return;
        if (result.ok) setLoaded({ key: referenceIdentity, execution: result }); else fail(result.message);
      }
    };
    void load().catch((error) => {
      if (current) fail(error instanceof Error ? error.message : "Could not read saved input.");
    });
    return () => { current = false; };
  }, [identity, active]);
  const text = message.role === "user" ? receipt?.captured.coordination ? coordinationDeliveryText(receipt.dispatched ?? receipt.captured) : observed?.coordination?.text ?? message.text : message.text;
  const captured = receipt?.dispatched ?? receipt?.captured;
  const coordination = message.role !== "user" ? null : captured?.coordination
    ? { id: captured.coordination.id, consultation: readCoordinationNotification(captured)?.consultation ?? text }
    : observed?.coordination ?? null;
  const readError = currentRead?.error ?? (routeError?.key === referenceIdentity ? routeError.message : "");
  const setReadError = (message: string) => setRouteError({ key: referenceIdentity, message });
  return { input, text, coordination, execution, observed, origin, senderTheme: observed?.senderTheme ?? null, statusReference, receiptId, identity, readError, setReadError, setRevision };
}

type TurnExecutionDetailsProps = TurnInputProps & { hasRunChecks?: boolean; displayReadError?: string; onRetryDisplay?: () => void };

export function TurnExecutionDetails(props: TurnExecutionDetailsProps) {
  return <TurnInputDetailsContent {...props} read={useTurnInputRead(props, "details")} />;
}

export function TurnInputReadBoundary({ children, ...props }: TurnInputProps & { children: (read: ReturnType<typeof useTurnInputRead>) => ReactNode }) {
  return children(useTurnInputRead({ ...props, active: props.message.role === "user" || (props.message.role === "assistant" && props.message.runFailure !== undefined) }));
}

export function TurnInputOriginAvatar({ read, origin = read.origin }: { read: ReturnType<typeof useTurnInputRead>;
  origin?: ReturnType<typeof useTurnInputRead>["origin"] }) {
  if (origin?.kind !== "session") return null;
  const character = origin.actorSnapshot?.character ?? { name: "Unknown Sender", iconPath: "" };
  return <><div className="message-avatar-stack">
    <CharacterAvatar character={character} size="small" className="message-avatar" />
  </div><div className="message-character-name">{character.name}</div></>;
}

export function TurnInputStatus({ message }: { message: Message }) {
  const input = message.turnInput;
  if (message.role !== "user" || !input) return null;
  return <AdditionalInputStatus state={input.state} />;
}

export function AdditionalInputStatus({ state }: { state: NonNullable<Message["turnInput"]>["state"] }) {
  return <>
    {state === "unknown" ? <p className="message-paragraph" role="alert">Delivery or saving could not be confirmed. This input is not a confirmed addition.</p> : null}
    {state === "not-sent" ? <p className="message-paragraph" role="alert">This input was not delivered to the Turn. It has not been sent as a new Turn.</p> : null}
  </>;
}

export function SessionOriginRoute({ origin, target, onError, onOpenRecipientThread }: {
  origin: SessionTurnQueueOrigin | SessionSteerOrigin; target?: SessionTarget;
  onError: (message: string) => void; onOpenRecipientThread?: () => void;
}) {
  const outbound = target !== undefined;
  const snapshot = outbound ? origin.targetSnapshot : origin.actorSnapshot;
  const recipient = origin.targetSnapshot?.character.name ?? "Unknown Recipient";
  const sessionTitle = snapshot?.sessionTitle ?? "Unknown Session";
  const route = target ? target.kind === "auxiliary" ? [target.mainSessionId, target.sessionId] as const : [target.sessionId] as const : origin.actorKind === "auxiliary"
    ? origin.actorMainSessionId && origin.actorSessionId ? [origin.actorMainSessionId, origin.actorSessionId] as const : null
    : origin.actorSessionId ? [origin.actorSessionId] as const : null;
  return <div className="session-message-address">
    {outbound && onOpenRecipientThread
      ? <button type="button" className="session-message-mention" title={`Go to this instruction in: ${sessionTitle}`}
          aria-label={`@${recipient}: Go to this instruction in ${sessionTitle}`} onClick={onOpenRecipientThread}>@{recipient}</button>
      : <span className="session-message-mention" title={`Recipient: ${recipient}`}>@{recipient}</span>}
    <button type="button" className="related-session-route" disabled={!route || !getWithMateApi()?.openSession}
    title={sessionTitle} aria-label={`${outbound ? "Open Recipient" : "Open Sender"}: ${sessionTitle}`}
    onClick={() => { if (route) void getWithMateApi()!.openSession(route[0], route[1]).catch((failure) => onError(failure instanceof Error ? failure.message : "Could not open sender Session.")); }}>
    <span className="related-session-direction" aria-hidden="true">{outbound ? "To" : "From"}</span>
    <span className="related-session-title">{sessionTitle}</span>
  </button></div>;
}

function TurnInputDetailsContent({ message, receipt, read, hasRunChecks = false, displayReadError, onRetryDisplay }: TurnExecutionDetailsProps & { read: ReturnType<typeof useTurnInputRead> }) {
  const { execution, origin, statusReference, readError, setRevision } = read;
  if (message.role !== "assistant" || !statusReference) return null;
  const sourceWaitState = getQueuedSourceWaitState(receipt);
  const captured = receipt?.dispatched ?? receipt?.captured;
  const settings = execution?.executionSettings ?? (captured ? { source: "input" as const, provider: captured.provider, ...captured.request.executionOptions } : null);
  const hasDelivery = execution?.receiptId || receipt;
  const error = readError || displayReadError;
  return <section className="turn-input-details" aria-label="Turn Input Details">
    {!hasRunChecks && settings ? <ExecutionSettings settings={settings} /> : null}
    {hasDelivery ? <details className="artifact-fold" aria-label="Input State" open>
      <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Input State</strong></span></summary>
      <dl className="check-list turn-input-rows artifact-fold-body" aria-label="Input State">
        {sourceWaitState === "unknown" ? <InputDetailRow label="Delivery"><span className="turn-input-state">Source Turn State Unknown</span></InputDetailRow> : null}
        <InputDetailRow label="Receipt State">{inputDetailStateLabel(execution?.receiptState ?? receipt?.state, "No Receipt")}</InputDetailRow>
        <InputDetailRow label="Turn State">{inputDetailStateLabel(execution?.turnState, "Not Confirmed")}</InputDetailRow>
        {execution?.inputs?.entry?.comparison === "changed" ? <InputDetailRow label="Starting Input">Edited before this Turn started</InputDetailRow> : null}
        {execution?.retrySource?.changedSinceAcceptance ? <InputDetailRow label="Original Input">Edited before the original Turn started</InputDetailRow> : null}
        {execution?.retrySource ? <InputDetailRow label="Retry Source">{retrySourceLabel(execution.retrySource.origin)}</InputDetailRow> : null}
        {origin?.operation === "send" && origin.kind === "session" ? <InputDetailRow label="Delivery Timing">{origin.deliveryTiming === "after_source_turn" ? "After Sender Turn" : "Immediate"}</InputDetailRow> : null}
        {origin?.operation === "send" && origin.kind === "session" && origin.sourceTurnPhase ? <InputDetailRow label="Sender Turn Outcome">{inputDetailStateLabel(origin.sourceTurnPhase, "Not Confirmed")}</InputDetailRow> : null}
      </dl>
    </details> : null}
    {error ? <p role="alert">{error} <button type="button" className="drawer-toggle compact secondary" onClick={() => {
      if (readError) setRevision((value) => value + 1);
      if (displayReadError) onRetryDisplay?.();
    }}>Retry Input Details</button></p> : null}
    {!execution && !readError ? <LoadingIndicator inline label="Loading input details" /> : null}
  </section>;
}
