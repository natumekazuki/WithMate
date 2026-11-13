import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionTurnQueueReceipt, SessionTurnQueueOrigin, SessionSteerOrigin } from "../../../src-shared/session/session-turn-queue.js";
import type { SessionTarget } from "../../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";
import { approvalModeLabel } from "../../../src-shared/settings/approval-mode.js";
import { reasoningEffortLabel } from "../../../src-shared/settings/model-catalog.js";
import { codexSandboxModeOptions } from "../../../src-shared/settings/codex-sandbox-mode.js";

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
type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;
type InputReference = { receiptId: string; turnId?: never } | { turnId: string; receiptId?: never };

export function InputDetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="check-item"><dt><span>{label}</span></dt><dd><strong>{children}</strong></dd></div>;
}

export function inputDetailStateLabel(value: string | null | undefined, fallback: string) {
  return value ? value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
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

export function useTurnInputRead({ message, receipt, context, turnId, active = true }: TurnInputProps) {
  const input = message.turnInput;
  const [execution, setExecution] = useState<Execution | null>(null);
  const [readError, setReadError] = useState("");
  const [revision, setRevision] = useState(0);
  const receiptId = receipt?.id ?? input?.queueId;
  const reference: InputReference | null = receiptId ? { receiptId } : input || turnId ? { turnId: input?.turnId ?? turnId! } : null;
  const statusReference = reference ?? (message.historyIndex !== undefined ? { messageSeq: message.historyIndex } : null);
  const referenceIdentity = JSON.stringify([context, statusReference]);
  const loadedReference = useRef(referenceIdentity);
  const identity = JSON.stringify([context, statusReference, receipt?.updatedAt, input?.state, revision]);
  useEffect(() => {
    const api = getWithMateApi();
    if (!active || !context) return;
    const refresh = (sessionId: string) => { if (sessionId === context.target.sessionId) setRevision((value) => value + 1); };
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => { queueChanged?.(); turnUpdated?.(); };
  }, [context?.target.sessionId, context?.ownerSessionId, active]);
  useEffect(() => {
    if (loadedReference.current !== referenceIdentity) { setExecution(null); loadedReference.current = referenceIdentity; }
    setReadError("");
    const api = getWithMateApi();
    if (!active || !context || !statusReference || !api?.readSessionExecution) return;
    let current = true;
    void api.readSessionExecution(context.ownerSessionId, "get_execution", { target: context.target, ...statusReference }).then(async (result) => {
      if (!current) return;
      if (result.ok && message.role === "assistant" && !result.receiptId && result.userMessageSeq !== null) {
        result = await api.readSessionExecution(context.ownerSessionId, "get_execution", { target: context.target, messageSeq: result.userMessageSeq });
      }
      if (!current) return;
      if (result.ok) setExecution(result); else setReadError(result.message);
    }).catch((error) => { if (current) setReadError(error instanceof Error ? error.message : "Could not read saved input."); });
    return () => { current = false; };
  }, [identity, active]);
  const observed = loadedReference.current === referenceIdentity ? execution : null;
  // A direct additional input belongs to its own sender, not the Turn's start input.
  const origin = input && !receiptId ? input.origin : observed?.origin ?? receipt?.accepted?.origin ?? receipt?.captured.origin;
  return { input, execution: loadedReference.current === referenceIdentity ? execution : null, observed, origin, statusReference, receiptId, identity, readError, setReadError, setRevision };
}

export function TurnExecutionDetails(props: TurnInputProps & { hasRunChecks?: boolean }) {
  return <TurnInputDetailsContent {...props} read={useTurnInputRead(props)} />;
}

export function TurnInputReadBoundary({ children, ...props }: TurnInputProps & { children: (read: ReturnType<typeof useTurnInputRead>) => ReactNode }) {
  return children(useTurnInputRead({ ...props, active: props.message.role === "user" }));
}

export function TurnInputOriginAvatar({ read }: { read: ReturnType<typeof useTurnInputRead> }) {
  const origin = read.origin;
  if (origin?.kind !== "session") return null;
  const character = origin.actorSnapshot?.character ?? { name: "Unknown Sender", iconPath: "" };
  return <><div className="message-avatar-stack">
    <CharacterAvatar character={character} size="small" className="message-avatar" />
  </div><div className="message-character-name">{character.name}</div></>;
}

export function TurnInputStatus({ message }: { message: Message }) {
  const input = message.turnInput;
  if (message.role !== "user" || !input) return null;
  return <>
    <p className="turn-input-state" role={input.state === "pending" ? "status" : undefined}>{deliveryLabels[input.state]}</p>
    {input.state === "unknown" ? <p>Delivery or saving could not be confirmed. This input is not a confirmed addition.</p> : null}
    {input.state === "not-sent" ? <p>This input was not delivered to the Turn. It has not been sent as a new Turn.</p> : null}
  </>;
}

export function SessionOriginRoute({ origin, target, onError }: { origin: SessionTurnQueueOrigin | SessionSteerOrigin; target?: SessionTarget; onError: (message: string) => void }) {
  const outbound = target !== undefined;
  const snapshot = outbound ? origin.targetSnapshot : origin.actorSnapshot;
  const recipient = origin.targetSnapshot?.character.name ?? "Unknown Recipient";
  const sessionTitle = snapshot?.sessionTitle ?? "Unknown Session";
  const route = target ? target.kind === "auxiliary" ? [target.mainSessionId, target.sessionId] as const : [target.sessionId] as const : origin.actorKind === "auxiliary"
    ? origin.actorMainSessionId && origin.actorSessionId ? [origin.actorMainSessionId, origin.actorSessionId] as const : null
    : origin.actorSessionId ? [origin.actorSessionId] as const : null;
  return <div className="session-message-address">
    <span className="session-message-mention" title={`Recipient: ${recipient}`}>@{recipient}</span>
    <button type="button" className="related-session-route" disabled={!route || !getWithMateApi()?.openSession}
    title={sessionTitle} aria-label={`${outbound ? "Open Recipient" : "Open Sender"}: ${sessionTitle}`}
    onClick={() => { if (route) void getWithMateApi()!.openSession(route[0], route[1]).catch((failure) => onError(failure instanceof Error ? failure.message : "Could not open sender Session.")); }}>
    <span className="related-session-direction" aria-hidden="true">{outbound ? "To" : "From"}</span>
    <span className="related-session-title">{sessionTitle}</span>
  </button></div>;
}

function TurnInputDetailsContent({ message, receipt, read, hasRunChecks = false }: TurnInputProps & { read: ReturnType<typeof useTurnInputRead>; hasRunChecks?: boolean }) {
  const { execution, observed, origin, statusReference, readError, setRevision } = read;
  if (message.role !== "assistant" || !statusReference) return null;
  const sourceWaitState = getQueuedSourceWaitState(receipt);
  const captured = receipt?.dispatched ?? receipt?.captured;
  const settings = execution?.executionSettings ?? (captured ? { source: "input" as const, provider: captured.provider, ...captured.request.executionOptions } : null);
  const hasDelivery = observed?.receiptId || receipt;
  return <section className="turn-input-details" aria-label="Turn Input Details">
    {!hasRunChecks && settings ? <ExecutionSettings settings={settings} /> : null}
    {hasDelivery ? <details className="artifact-fold" aria-label="Input State" open>
      <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Input State</strong></span></summary>
      <dl className="check-list turn-input-rows artifact-fold-body" aria-label="Input State">
        {sourceWaitState ? <InputDetailRow label="Delivery"><span className="turn-input-state">{sourceWaitState === "waiting" ? "Waiting For Sender Turn" : "Source Turn State Unknown"}</span></InputDetailRow> : null}
        <InputDetailRow label="Receipt State">{inputDetailStateLabel(observed?.receiptState ?? receipt?.state, "No Receipt")}</InputDetailRow>
        <InputDetailRow label="Turn State">{inputDetailStateLabel(observed?.turnState, "Not Confirmed")}</InputDetailRow>
        {origin?.operation === "send" && origin.kind === "session" ? <InputDetailRow label="Delivery Timing">{origin.deliveryTiming === "after_source_turn" ? "After Sender Turn" : "Immediate"}</InputDetailRow> : null}
        {origin?.operation === "send" && origin.kind === "session" && origin.sourceTurnPhase ? <InputDetailRow label="Sender Turn Outcome">{inputDetailStateLabel(origin.sourceTurnPhase, "Not Confirmed")}</InputDetailRow> : null}
      </dl>
    </details> : null}
    {readError ? <p role="alert">{readError} <button type="button" className="drawer-toggle compact secondary" onClick={() => setRevision((value) => value + 1)}>Retry Input Details</button></p> : null}
    {!observed && !readError ? <LoadingIndicator inline label="Loading input details" /> : null}
  </section>;
}
