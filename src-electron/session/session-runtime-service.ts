import { currentTimestampLabel as defaultCurrentTimestampLabel } from "../../src-shared/time-state.js";
import type { AuditLogEntry, ComposerPreview, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, RunSessionTurnRequest, SessionContextTelemetry, SteerSessionTurnRequest, SteerSessionTurnResult } from "../../src-shared/session/runtime-state.js";
import type { MessageArtifact } from "../../src-shared/session/session-state.js";
import type { ProjectMemoryEntry, SessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { normalizeSessionTurnCorrelation } from "../../src-shared/session/runtime-state.js";
import { validateSessionExecutionOptions, type SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { type CharacterProfile } from "../../src-shared/character/character-state.js";
import { buildLiveRunAuditOperations } from "../../src-shared/session/live-run-audit-operations.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type ProviderPromptComposition,
  type RunSessionTurnResult,
} from "../providers/provider-runtime.js";
import { appendQuotaTelemetryToTransportPayload } from "./audit-log-quota.js";
import { appendTransportPayloadFields, calculateAuditDurationMs } from "./audit-log-metadata.js";
import { estimateLogicalPromptTokens } from "../providers/prompt-token-estimate.js";
import { toAuditTextPreview } from "./audit-payload-limits.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionTurnTerminalNotification } from "./session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import type { ConversationTimingContext } from "./conversation-timing.js";
import type { CharacterContextResponse } from "../../src-shared/character-context/character-context-contract.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "./session-run-timeouts.js";
import type { AuditLogProgressPatch, AuditLogProgressAck } from "../../src-shared/session/runtime-state.js";
import type { RunSessionTurnProgressChanges } from "../providers/provider-runtime.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";
const DEFAULT_AUDIT_ENRICHMENT_GRACE_MS = 5_000;
const DEFAULT_APPRAISAL_READY_RETRY_MS = 1_000;
const AUDIT_ENRICHMENT_TIMEOUT = Symbol("audit-enrichment-timeout");
const MAX_PENDING_AUDIT_PATCHES = 64;
const MAX_PENDING_AUDIT_PATCH_CHARS = 4 * 1024 * 1024;

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

export type SessionRuntimeServiceDeps = {
  runSessionAdmissionExclusive?<T>(
    sessionId: string,
    operation: () => T | Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  getSession(sessionId: string): Awaitable<Session | null>;
  upsertSession(
    session: Session,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session>;
  persistRunningTurnStart?(session: Session, expectedMessageCount: number): Awaitable<Session>;
  clearCharacterAuthoringRuntimeState?(session: Session): Awaitable<Session>;
  upsertTerminalSession?(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session>;
  resolveRuntimeSessionForTurn?: (session: Session) => Awaitable<Session>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  resolveProviderSession?: (session: Session) => Awaitable<Session>;
  resolveSessionFolderPath?: (sessionId: string) => Awaitable<string>;
  resolveSessionCharacter?: (session: Session) => Promise<CharacterProfile | null>;
  getAppSettings: () => Awaitable<AppSettings>;
  resolveProviderCatalog(providerId: string | null | undefined, revision?: number | null): Awaitable<{
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  }>;
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
  getSessionMemory(session: Session): Awaitable<SessionMemory>;
  resolveProjectMemoryEntriesForPrompt(
    session: Session,
    userMessage: string,
    sessionMemory: SessionMemory,
  ): Awaitable<ProjectMemoryEntry[]>;
  resolveConversationTimingContext?: (
    session: Session,
    observedAt: Date,
  ) => Awaitable<ConversationTimingContext | null>;
  resolveCharacterContext?: (
    session: Session,
    query: string,
  ) => Awaitable<CharacterContextResponse | null>;
  queueCompletedTurnAppraisal?: (input: {
    session: Session;
    correlationId: string;
    userMessage: string;
    assistantMessage: string;
    assistantMessageIndex: number;
    occurredAt: string;
  }) => Awaitable<void>;
  markCompletedTurnAppraisalReady?: (
    correlationId: string,
  ) => Awaitable<"ready" | "absent" | void>;
  requireDurableCompletedTurnAppraisal?: boolean;
  appraiseCompletedTurn?: () => Awaitable<void>;
  createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLog(id: number, entry: CreateAuditLogInput): Awaitable<void | AuditLogEntry>;
  updateAuditLogProgress(id: number, patch: AuditLogProgressPatch): Awaitable<AuditLogProgressAck>;
  setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void;
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  waitForApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
  ): Promise<LiveApprovalDecision> | LiveApprovalDecision;
  waitForElicitationResponse(
    sessionId: string,
    request: LiveElicitationRequest,
    signal: AbortSignal,
  ): Promise<LiveElicitationResponse> | LiveElicitationResponse;
  setProviderQuotaTelemetry(telemetry: ProviderQuotaTelemetry): void;
  setSessionContextTelemetry(telemetry: SessionContextTelemetry): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  resetProviderSessionThread?(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  /** Persisted Auxiliary threads must not be replaced silently after resume failure. */
  isAuxiliarySession?(sessionId: string): Awaitable<boolean>;
  getProviderAgentRuntimeBinding?(input: {
    session: Session;
    provider: ModelCatalogProvider;
  }): Awaitable<ProviderAgentRuntimeBindingProjection | null>;
  beginProviderAgentRuntimeTurn?(input: {
    session: Session;
    provider: ModelCatalogProvider;
    binding: ProviderAgentRuntimeBindingProjection | null;
  }): Awaitable<{
    handle: unknown;
    binding: ProviderAgentRuntimeBindingProjection | null;
  } | undefined>;
  endProviderAgentRuntimeTurn?(handle: unknown): void;
  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void;
  broadcastLiveSessionRun(sessionId: string): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
  resolvePendingElicitationRequest(sessionId: string, response: LiveElicitationResponse): void;
  getMateState?: () => MateStorageState;
  notifySessionTurnTerminal?: (notification: SessionTurnTerminalNotification) => Awaitable<void>;
  currentTimestampLabel?: () => string;
  currentDate?: () => Date;
  providerCancelGraceMs?: number;
  auditEnrichmentGraceMs?: number;
  appraisalReadyRetryMs?: number;
};

function notifySessionTurnTerminalBestEffort(
  notify: SessionRuntimeServiceDeps["notifySessionTurnTerminal"],
  notification: SessionTurnTerminalNotification,
): void {
  if (!notify) {
    return;
  }

  try {
    void Promise.resolve(notify(notification))
      .catch((error) => console.warn("Session turn terminal notification failed", error));
  } catch (error) {
    console.warn("Session turn terminal notification failed", error);
  }
}

function invalidateProviderSessionThreadBestEffort(
  invalidate: SessionRuntimeServiceDeps["invalidateProviderSessionThread"],
  providerId: string | null | undefined,
  sessionId: string,
): void {
  try {
    void Promise.resolve(invalidate(providerId, sessionId))
      .catch((error) => console.warn("Detached provider session invalidation failed", error));
  } catch (error) {
    console.warn("Detached provider session invalidation failed", error);
  }
}

function appraiseCompletedTurnBestEffort(
  appraise: SessionRuntimeServiceDeps["appraiseCompletedTurn"],
): void {
  if (!appraise) {
    return;
  }

  try {
    void Promise.resolve(appraise())
      .catch((error) => console.warn(
        "Character affect turn appraisal failed",
        error instanceof Error ? error.name : "UnknownError",
      ));
  } catch (error) {
    console.warn(
      "Character affect turn appraisal failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

async function markCompletedTurnAppraisalReadyWithRetry(
  markReady: NonNullable<SessionRuntimeServiceDeps["markCompletedTurnAppraisalReady"]>,
  correlationId: string,
  retryMs: number,
): Promise<boolean> {
  while (true) {
    try {
      const result = await markReady(correlationId);
      return result !== "absent";
    } catch (error) {
      console.warn(
        "Character affect turn appraisal readiness update failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function completeCompletedTurnAppraisalBestEffort(
  markReady: SessionRuntimeServiceDeps["markCompletedTurnAppraisalReady"],
  appraise: SessionRuntimeServiceDeps["appraiseCompletedTurn"],
  correlationId: string,
  retryMs: number,
): void {
  setTimeout(() => {
    void Promise.resolve().then(async () => {
      if (markReady) {
        const ready = await markCompletedTurnAppraisalReadyWithRetry(
          markReady,
          correlationId,
          retryMs,
        );
        if (!ready) {
          return;
        }
      }
      appraiseCompletedTurnBestEffort(appraise);
    })
    .catch((error) => console.warn(
      "Character affect turn background completion failed",
      error instanceof Error ? error.name : "UnknownError",
    ));
  }, 0);
}

function runInBackgroundMacrotask(label: string, operation: () => Promise<void>): void {
  setTimeout(() => {
    void operation().catch((error) => console.warn(label, error));
  }, 0);
}

async function waitForAuditEnrichment<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof AUDIT_ENRICHMENT_TIMEOUT> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof AUDIT_ENRICHMENT_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(AUDIT_ENRICHMENT_TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildCanceledPartialResult(
  liveState: LiveSessionRunState | null,
  prompt: ProviderPromptComposition,
): RunSessionTurnResult {
  return {
    threadId: liveState?.threadId || null,
    assistantText: liveState?.assistantText ?? "",
    logicalPrompt: prompt.logicalPrompt,
    transportPayload: null,
    operations: liveState ? buildLiveRunAuditOperations(liveState) : [],
    rawItemsJson: "[]",
    usage: liveState?.usage ?? null,
    providerQuotaTelemetry: null,
  };
}

function waitForProviderTurnWithCancelDeadline(
  providerPromise: Promise<RunSessionTurnResult>,
  signal: AbortSignal,
  graceMs: number,
  buildPartialResult: () => RunSessionTurnResult,
  onCancelDeadline: (providerPromise: Promise<RunSessionTurnResult>) => void,
): Promise<RunSessionTurnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      timeout = setTimeout(() => {
        onCancelDeadline(providerPromise);
        settle(() => reject(new ProviderTurnError(
          "Provider did not stop within the cancellation grace period",
          buildPartialResult(),
          true,
          "canceled",
        )));
      }, graceMs);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    providerPromise.then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}

function createCanceledRunError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfRunCanceled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createCanceledRunError("Session setup was canceled");
  }
}

function waitForSetupWithCancelDeadline<T>(
  setupPromise: Promise<T>,
  signal: AbortSignal,
  graceMs: number,
  isSetupPending: () => boolean,
  onCancelDeadline: (setupPromise: Promise<T>) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      timeout = setTimeout(() => {
        if (!isSetupPending()) {
          return;
        }
        onCancelDeadline(setupPromise);
        settle(() => reject(createCanceledRunError("Session setup did not stop within the cancellation grace period")));
      }, graceMs);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    setupPromise.then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}

export function isCanceledRunError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /abort|aborted|cancel|canceled|cancelled/i.test(message);
}

function hasMeaningfulArtifact(artifact: MessageArtifact | undefined): boolean {
  if (!artifact) {
    return false;
  }

  return artifact.changedFiles.length > 0 ||
    artifact.activitySummary.some((summary) => summary.trim().length > 0) ||
    (artifact.operationTimeline?.length ?? 0) > 0 ||
    artifact.runChecks.length > 0;
}

export function hasMeaningfulPartialRunResult(partialResult: RunSessionTurnResult | null | undefined): boolean {
  if (!partialResult) {
    return false;
  }

  return partialResult.assistantText.trim().length > 0 ||
    partialResult.operations.length > 0 ||
    hasMeaningfulArtifact(partialResult.artifact);
}

function normalizeProviderErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim().toLowerCase() : "";
}

export function isRetryableStaleThreadSessionError(error: unknown): boolean {
  const code = normalizeProviderErrorCode(error);
  if (
    code === "thread_not_found" ||
    code === "session_not_found" ||
    code === "thread_expired" ||
    code === "session_expired" ||
    code === "invalid_thread" ||
    code === "invalid_session" ||
    code === "invalid-thread" ||
    code === "invalid-session"
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.trim().toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  return (
    /\bsessionnotfound\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\bnot found\b/.test(normalizedMessage) ||
    /\bnot found\b.*\b(thread|session)\b/.test(normalizedMessage) ||
    /\b(thread|session)[-_]not[-_]found\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\bexpired\b/.test(normalizedMessage) ||
    /\bexpired\b.*\b(thread|session)\b/.test(normalizedMessage) ||
    /\binvalid[-\s]+(thread|session)\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\binvalid\b/.test(normalizedMessage) ||
    /\binvalid[-\s]*thread\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\bmodel\b.*\bincompatible\b/.test(normalizedMessage) ||
    /\bmodel\b.*\b(thread|session)\b.*\bincompatible\b/.test(normalizedMessage)
  );
}

function isRetryableCodexThreadBootstrapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.trim().toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  return /codex exec exited with code 1:\s*reading prompt from stdin\.\.\./.test(normalizedMessage);
}

function shouldRetryUnusableThreadRun(
  error: unknown,
  partialResult: RunSessionTurnResult | null | undefined,
): boolean {
  if (hasMeaningfulPartialRunResult(partialResult)) {
    return false;
  }

  return isRetryableStaleThreadSessionError(error) || isRetryableCodexThreadBootstrapError(error);
}

function shouldResetFailedSessionThread(
  error: unknown,
  currentThreadId: string,
  partialResult: RunSessionTurnResult | null | undefined,
  canceled: boolean,
): boolean {
  if (canceled || !shouldRetryUnusableThreadRun(error, partialResult)) {
    return false;
  }

  const candidateThreadId = pickPreferredThreadId(partialResult?.threadId, currentThreadId);
  return candidateThreadId.length > 0;
}

function extractProviderUsageLimitRetryAt(message: string): string | null {
  const match = /\btry again at\s+(.+?)(?:\.|$)/i.exec(message);
  return match?.[1]?.trim() || null;
}

function formatProviderUsageLimitMessage(providerId: Session["provider"], message: string): string {
  const providerLabel = providerId === "codex" ? "Codex" : "Provider";
  const retryAt = extractProviderUsageLimitRetryAt(message);
  if (retryAt) {
    return `${providerLabel} usage limit reached.\nTry again at: ${retryAt}`;
  }

  const preview = toAuditTextPreview(message) ?? message;
  return `${providerLabel} usage limit reached.\nDetails: ${preview}`;
}

function formatProviderFailureMessage(params: {
  providerId: Session["provider"];
  reason: ProviderTurnError["reason"] | null;
  message: string;
  canceled: boolean;
}): string {
  if (params.canceled) {
    return "Canceled by the user.";
  }

  if (params.reason === "usage_limit") {
    return formatProviderUsageLimitMessage(params.providerId, params.message);
  }

  return params.message;
}

function formatProviderFailureNotice(params: {
  providerId: Session["provider"];
  reason: ProviderTurnError["reason"] | null;
  message: string;
  canceled: boolean;
}): string {
  if (params.canceled) {
    return "Run canceled.";
  }

  if (params.reason === "usage_limit") {
    return formatProviderUsageLimitMessage(params.providerId, params.message);
  }

  return `The run failed.\n${params.message}`;
}

function pickPreferredThreadId(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const normalized = candidate?.trim() ?? "";
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return "";
}

function buildEmptyLiveSessionRunState(sessionId: string, threadId: string): LiveSessionRunState {
  return {
    sessionId,
    threadId,
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

function buildRunningAuditEntry(params: {
  sessionId: string;
  createdAt: string;
  session: Pick<Session, "provider" | "threadId" | "messages">;
  executionOptions: SessionExecutionOptions;
  logicalPrompt: CreateAuditLogInput["logicalPrompt"];
  threadId?: string;
  clientRequestId?: string | null;
  submitSource?: RunSessionTurnRequest["submitSource"];
}): CreateAuditLogInput {
  return {
    sessionId: params.sessionId,
    createdAt: params.createdAt,
    phase: "running",
    provider: params.session.provider,
    model: params.executionOptions.model,
    reasoningEffort: params.executionOptions.reasoningEffort,
    approvalMode: params.executionOptions.approvalMode,
    sandboxMode: params.executionOptions.codexSandboxMode,
    userMessageSeq: Math.max(0, params.session.messages.length - 1),
    threadId: params.threadId ?? params.session.threadId,
    logicalPrompt: params.logicalPrompt,
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    providerMetadata: params.clientRequestId
      ? [{
          provider: params.session.provider,
          kind: "session_turn_request",
          source: "session-runtime-service.run-session-turn",
          summary: "Session turn request correlation",
          payload: {
            clientRequestId: params.clientRequestId,
            submitSource: params.submitSource ?? null,
          },
        }]
      : [],
    usage: null,
    errorMessage: "",
  };
}

function hasNonEmptyAssistantText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyRawItemsJson(value: string | null | undefined): value is string {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized !== "[]";
}

function buildAuditOperationMergeKey(operation: CreateAuditLogInput["operations"][number]): string {
  return `${operation.type}\u0000${operation.summary}`;
}

function ensureAuditTransportPayload(
  payload: CreateAuditLogInput["transportPayload"],
): NonNullable<CreateAuditLogInput["transportPayload"]> {
  return payload ?? { summary: "prompt estimate", fields: [] };
}

function mergeTerminalAuditOperations(
  baseOperations: CreateAuditLogInput["operations"],
  terminalOperations: CreateAuditLogInput["operations"] | null | undefined,
): CreateAuditLogInput["operations"] {
  if (!terminalOperations || terminalOperations.length === 0) {
    return baseOperations;
  }

  const absorbedOperationCounts = new Map<string, number>();
  for (const operation of terminalOperations) {
    const key = buildAuditOperationMergeKey(operation);
    absorbedOperationCounts.set(key, (absorbedOperationCounts.get(key) ?? 0) + 1);
  }

  return [
    ...terminalOperations,
    ...baseOperations.filter((operation) => {
      const key = buildAuditOperationMergeKey(operation);
      const absorbedCount = absorbedOperationCounts.get(key) ?? 0;
      if (absorbedCount <= 0) {
        return true;
      }

      absorbedOperationCounts.set(key, absorbedCount - 1);
      return false;
    }),
  ];
}

function buildTerminalAuditEntry(params: {
  baseEntry: CreateAuditLogInput;
  phase: CreateAuditLogInput["phase"];
  completedAt: string;
  session: Pick<Session, "provider">;
  executionOptions: SessionExecutionOptions;
  threadId?: string | null;
  logicalPrompt?: CreateAuditLogInput["logicalPrompt"];
  transportPayload?: CreateAuditLogInput["transportPayload"];
  assistantText?: string | null;
  operations?: CreateAuditLogInput["operations"] | null;
  rawItemsJson?: string | null;
  providerMetadata?: CreateAuditLogInput["providerMetadata"] | null;
  usage?: CreateAuditLogInput["usage"];
  assistantMessageSeq?: CreateAuditLogInput["assistantMessageSeq"];
  errorMessage: string;
}): CreateAuditLogInput {
  const { baseEntry } = params;
  return {
    ...baseEntry,
    phase: params.phase,
    createdAt: params.completedAt,
    provider: params.session.provider,
    model: params.executionOptions.model,
    reasoningEffort: params.executionOptions.reasoningEffort,
    approvalMode: params.executionOptions.approvalMode,
    threadId: pickPreferredThreadId(params.threadId, baseEntry.threadId),
    logicalPrompt: params.logicalPrompt ?? baseEntry.logicalPrompt,
    transportPayload: params.transportPayload ?? baseEntry.transportPayload,
    assistantText: hasNonEmptyAssistantText(params.assistantText) ? params.assistantText : baseEntry.assistantText,
    operations: mergeTerminalAuditOperations(baseEntry.operations, params.operations),
    rawItemsJson: hasNonEmptyRawItemsJson(params.rawItemsJson) ? params.rawItemsJson : baseEntry.rawItemsJson,
    providerMetadata: [
      ...(baseEntry.providerMetadata ?? []),
      ...(params.providerMetadata ?? []),
    ],
    usage: params.usage ?? baseEntry.usage,
    assistantMessageSeq: params.assistantMessageSeq ?? baseEntry.assistantMessageSeq ?? null,
    errorMessage: params.errorMessage,
  };
}

export function preserveSessionTurnRequestMetadata(
  providerMetadata: CreateAuditLogInput["providerMetadata"],
): NonNullable<CreateAuditLogInput["providerMetadata"]> {
  return (providerMetadata ?? []).filter((entry) => entry.kind === "session_turn_request");
}

function buildDegradedCompletedAuditEntry(params: {
  completedAuditEntry: CreateAuditLogInput;
  auditUpdateError: unknown;
  completedAt: string;
}): CreateAuditLogInput {
  const message = params.auditUpdateError instanceof Error
    ? params.auditUpdateError.message
    : String(params.auditUpdateError);
  return {
    ...params.completedAuditEntry,
    createdAt: params.completedAt,
    phase: "completed",
    operations: [],
    rawItemsJson: "",
    providerMetadata: [
      ...preserveSessionTurnRequestMetadata(params.completedAuditEntry.providerMetadata),
      {
        provider: params.completedAuditEntry.provider,
        kind: "audit_persistence_degraded",
        source: "session-runtime-service.completed-audit-update",
        summary: "Completed audit persistence degraded",
        payload: {
          message,
          operationCount: params.completedAuditEntry.operations.length,
          hadRawItems: params.completedAuditEntry.rawItemsJson.trim() !== "",
          hadProviderMetadata: (params.completedAuditEntry.providerMetadata ?? []).length > 0,
        },
      },
    ],
  };
}

export class SessionRuntimeService {
  private readonly inFlightSessionRuns = new Set<string>();
  private readonly startingSessionRuns = new Set<string>();
  private readonly terminatingSessionRuns = new Map<string, Set<Promise<unknown>>>();
  private readonly waitingSessionRunAdmissions = new Set<string>();
  private readonly pendingSessionRunCancels = new Set<string>();
  private readonly sessionRunControllers = new Map<string, AbortController>();
  private readonly pendingSessionInputs = new Map<string, Promise<SteerSessionTurnResult>>();
  private readonly dispatchedSessionInputs = new Set<string>();
  private readonly finishingSessionTurns = new Set<string>();
  private readonly appendSessionInput = new Map<string, (text: string) => Promise<void>>();

  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  private upsertTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session> {
    return this.deps.upsertTerminalSession?.(session, terminalCommit, options)
      ?? this.deps.upsertSession(session, options);
  }

  hasInFlightRuns(): boolean {
    return this.inFlightSessionRuns.size > 0
      || this.startingSessionRuns.size > 0
      || this.terminatingSessionRuns.size > 0;
  }

  isRunInFlight(sessionId: string): boolean {
    return this.inFlightSessionRuns.has(sessionId)
      || this.startingSessionRuns.has(sessionId)
      || this.terminatingSessionRuns.has(sessionId);
  }

  private cancellationState(sessionId: string): LiveSessionRunState["cancellationState"] {
    if (this.terminatingSessionRuns.has(sessionId)) {
      return "terminating";
    }
    return this.sessionRunControllers.get(sessionId)?.signal.aborted || this.pendingSessionRunCancels.has(sessionId)
      ? "requested"
      : undefined;
  }

  private setRuntimeLiveState(sessionId: string, state: LiveSessionRunState | null): void {
    const cancellationState = this.cancellationState(sessionId);
    const nextState = state && this.finishingSessionTurns.has(sessionId) ? { ...state, inputAvailable: false } : state;
    this.deps.setLiveSessionRun(sessionId, cancellationState
      ? { ...(nextState ?? buildEmptyLiveSessionRunState(sessionId, this.deps.getLiveSessionRun(sessionId)?.threadId ?? "")), inputAvailable: false, cancellationState }
      : nextState);
  }

  private releaseCancellationState(sessionId: string): void {
    if (this.isRunInFlight(sessionId) || this.waitingSessionRunAdmissions.has(sessionId)) {
      return;
    }
    const liveState = this.deps.getLiveSessionRun(sessionId);
    if (!liveState?.cancellationState) {
      return;
    }
    const { cancellationState: _cancellationState, ...rest } = liveState;
    this.deps.setLiveSessionRun(sessionId, rest.backgroundTasks.length > 0 || (rest.reasoningText ?? "").trim().length > 0 ? rest : null);
    this.deps.broadcastLiveSessionRun(sessionId);
  }

  private trackTerminatingSessionRun(sessionId: string, promise: Promise<unknown>): void {
    const trackedPromises = this.terminatingSessionRuns.get(sessionId) ?? new Set<Promise<unknown>>();
    if (trackedPromises.has(promise)) {
      return;
    }
    trackedPromises.add(promise);
    this.terminatingSessionRuns.set(sessionId, trackedPromises);
    this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
    this.deps.broadcastLiveSessionRun(sessionId);
    const release = () => {
      trackedPromises.delete(promise);
      if (trackedPromises.size === 0) {
        this.terminatingSessionRuns.delete(sessionId);
      }
      if (!this.startingSessionRuns.has(sessionId) && !this.inFlightSessionRuns.has(sessionId) && !this.terminatingSessionRuns.has(sessionId)) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
      }
      this.releaseCancellationState(sessionId);
    };
    promise.then(release, release);
  }

  reset(): void {
    for (const sessionId of new Set([...this.startingSessionRuns, ...this.inFlightSessionRuns])) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.sessionRunControllers.get(sessionId)?.abort();
      this.pendingSessionRunCancels.add(sessionId);
    }
    this.startingSessionRuns.clear();
    this.inFlightSessionRuns.clear();
    for (const sessionId of this.waitingSessionRunAdmissions) {
      this.pendingSessionRunCancels.add(sessionId);
    }
    this.waitingSessionRunAdmissions.clear();
    this.sessionRunControllers.clear();
  }

  cancelRun(sessionId: string): void {
    const controller = this.sessionRunControllers.get(sessionId);
    if (this.pendingSessionRunCancels.has(sessionId)) {
      return;
    }
    if (controller?.signal.aborted) {
      this.pendingSessionRunCancels.add(sessionId);
      return;
    }
    this.deps.resolvePendingApprovalRequest(sessionId, "deny");
    this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
    if (!controller) {
      if (this.waitingSessionRunAdmissions.has(sessionId)) {
        this.pendingSessionRunCancels.add(sessionId);
        this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      return;
    }

    this.pendingSessionRunCancels.add(sessionId);
    controller.abort();
    this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
    this.deps.broadcastLiveSessionRun(sessionId);
  }

  cancelAllRuns(): void {
    const sessionIds = new Set([
      ...this.inFlightSessionRuns,
      ...this.startingSessionRuns,
      ...this.waitingSessionRunAdmissions,
    ]);
    for (const sessionId of sessionIds) {
      this.cancelRun(sessionId);
    }
  }

  steerSessionTurn(sessionId: string, request: SteerSessionTurnRequest): Promise<SteerSessionTurnResult> {
    if (!request || typeof request.expectedTurnId !== "string" || !request.expectedTurnId.trim()
      || typeof request.userMessage !== "string" || !request.userMessage.trim()) {
      return Promise.reject(new Error("The active turn and a message are required."));
    }
    if (this.pendingSessionInputs.has(sessionId)) return Promise.reject(new Error("Session input is already being sent."));
    const runController = this.sessionRunControllers.get(sessionId);
    const appendInput = this.appendSessionInput.get(sessionId);
    const assertActiveTurn = () => {
      const live = this.deps.getLiveSessionRun(sessionId);
      if (!this.inFlightSessionRuns.has(sessionId) || !appendInput || this.appendSessionInput.get(sessionId) !== appendInput
        || !runController || this.sessionRunControllers.get(sessionId) !== runController
        || this.sessionRunControllers.get(sessionId)?.signal.aborted || this.terminatingSessionRuns.has(sessionId) || this.finishingSessionTurns.has(sessionId)
        || live?.cancellationState || live?.turnId !== request.expectedTurnId || live.inputAvailable !== true) {
        throw new Error("The selected turn no longer accepts input. Your draft is preserved.");
      }
    };
    const operation = (async () => {
      assertActiveTurn();
      const session = await this.deps.getSession(sessionId);
      if (!session || session.provider !== "codex" || isReadOnlySession(session)) throw new Error("This session cannot accept input.");
      const adapter = this.deps.getProviderCodingAdapter(session.provider);
      if (!adapter.steerSessionTurn) throw new Error("This provider cannot accept input during a turn.");
      const providerSession = await (this.deps.resolveProviderSession?.(session) ?? session);
      const preview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
      if (preview.errors.length) throw new Error(preview.errors[0]);
      assertActiveTurn();
      this.dispatchedSessionInputs.add(sessionId);
      try {
        const result = await adapter.steerSessionTurn({ sessionId, expectedTurnId: request.expectedTurnId, userMessage: request.userMessage.trim(), attachments: preview.attachments });
        if (result.turnId !== request.expectedTurnId) throw new Error("The provider did not confirm input for the selected turn.");
        if (!appendInput || this.appendSessionInput.get(sessionId) !== appendInput) throw new Error("The selected turn ended before input could be saved.");
        await appendInput(request.userMessage.trim());
        return result;
      } finally {
        this.dispatchedSessionInputs.delete(sessionId);
      }
    })();
    this.pendingSessionInputs.set(sessionId, operation);
    const release = () => { if (this.pendingSessionInputs.get(sessionId) === operation) this.pendingSessionInputs.delete(sessionId); };
    void operation.then(release, release);
    return operation;
  }

  canAcceptSessionInput(sessionId: string, expectedTurnId?: string): boolean {
    const live = this.deps.getLiveSessionRun(sessionId);
    return this.inFlightSessionRuns.has(sessionId) && this.appendSessionInput.has(sessionId)
      && !this.sessionRunControllers.get(sessionId)?.signal.aborted && !this.terminatingSessionRuns.has(sessionId)
      && !this.finishingSessionTurns.has(sessionId)
      && !live?.cancellationState && live?.inputAvailable === true && Boolean(live.turnId)
      && (expectedTurnId === undefined || live.turnId === expectedTurnId);
  }

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const runAbortController = new AbortController();
    if (this.isRunInFlight(sessionId) || this.waitingSessionRunAdmissions.has(sessionId)) {
      logSessionRunStuckInvestigation("runtime.admission.rejected", {
        sessionId,
        clientRequestId,
        guard: "runtime-in-flight",
        starting: this.startingSessionRuns.has(sessionId),
        running: this.inFlightSessionRuns.has(sessionId),
        terminating: this.terminatingSessionRuns.has(sessionId),
        waitingAdmission: this.waitingSessionRunAdmissions.has(sessionId),
        cancellationState: this.cancellationState(sessionId),
      });
      throw new Error("This session is already running.");
    }
    let admitted = false;
    this.waitingSessionRunAdmissions.add(sessionId);
    this.sessionRunControllers.set(sessionId, runAbortController);
    const admit = () => {
      this.waitingSessionRunAdmissions.delete(sessionId);
      if (this.isRunInFlight(sessionId)) {
        logSessionRunStuckInvestigation("runtime.admission.rejected", {
          sessionId,
          clientRequestId,
          guard: "admission-recheck",
        });
        throw new Error("This session is already running.");
      }
      this.startingSessionRuns.add(sessionId);
      this.finishingSessionTurns.delete(sessionId);
      this.sessionRunControllers.set(sessionId, runAbortController);
      admitted = true;
      if (this.pendingSessionRunCancels.delete(sessionId)) {
        runAbortController.abort();
      }
    };
    const admissionPromise = (async () => {
      try {
        if (this.deps.runSessionAdmissionExclusive) {
          await this.deps.runSessionAdmissionExclusive(sessionId, admit, runAbortController.signal);
        } else {
          admit();
        }
        throwIfRunCanceled(runAbortController.signal);
      } catch (error) {
        this.waitingSessionRunAdmissions.delete(sessionId);
        if (!admitted) {
          this.pendingSessionRunCancels.delete(sessionId);
        }
        if (admitted) {
          this.startingSessionRuns.delete(sessionId);
          if (this.sessionRunControllers.get(sessionId) === runAbortController && !this.terminatingSessionRuns.has(sessionId)) {
            this.sessionRunControllers.delete(sessionId);
          }
          this.pendingSessionRunCancels.delete(sessionId);
        }
        if (this.sessionRunControllers.get(sessionId) === runAbortController && !this.terminatingSessionRuns.has(sessionId)) {
          this.sessionRunControllers.delete(sessionId);
        }
        this.releaseCancellationState(sessionId);
        throw error;
      }
    })();
    try {
      await waitForSetupWithCancelDeadline(
        admissionPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () => this.waitingSessionRunAdmissions.has(sessionId) || this.startingSessionRuns.has(sessionId),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
      );
    } catch (error) {
      this.releaseCancellationState(sessionId);
      throw error;
    }
    logSessionRunStuckInvestigation("runtime.requested", {
      sessionId,
      clientRequestId,
      submitSource,
      isRunInFlight: false,
    });
    const setupPromise = this.runSessionTurnInternal(sessionId, request, runAbortController);
    try {
      return await waitForSetupWithCancelDeadline(
        setupPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () => this.startingSessionRuns.has(sessionId),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
      );
    } finally {
      this.startingSessionRuns.delete(sessionId);
      if (!this.inFlightSessionRuns.has(sessionId) && !this.terminatingSessionRuns.has(sessionId)) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
      }
      this.releaseCancellationState(sessionId);
    }
  }

  private async runSessionTurnInternal(
    sessionId: string,
    request: RunSessionTurnRequest,
    runAbortController: AbortController,
  ): Promise<Session> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const observedAt = (this.deps.currentDate ?? (() => new Date()))();
    const investigationStartedAt = Date.now();
    const storedSession = await this.deps.getSession(sessionId);
    throwIfRunCanceled(runAbortController.signal);
    if (!storedSession) {
      throw new Error("The session could not be found.");
    }
    const resolvedSession = await Promise.resolve(
      this.deps.resolveRuntimeSessionForTurn?.(storedSession) ?? storedSession,
    );
    const shouldResetCharacterAuthoringThread = storedSession.sessionKind === "character-authoring"
      && storedSession.characterRuntimeSnapshot !== null
      && resolvedSession.characterRuntimeSnapshot === null;
    let session = shouldResetCharacterAuthoringThread
      ? { ...resolvedSession, threadId: "" }
      : resolvedSession;
    if (shouldResetCharacterAuthoringThread) {
      if (!this.deps.clearCharacterAuthoringRuntimeState) {
        throw new Error("Character authoring runtime storage is unavailable.");
      }
      session = await this.deps.clearCharacterAuthoringRuntimeState(session);
      await this.deps.invalidateProviderSessionThread(storedSession.provider, storedSession.id);
    }
    throwIfRunCanceled(runAbortController.signal);
    logSessionRunStuckInvestigation("runtime.start", {
      sessionId,
      clientRequestId,
      provider: session.provider,
      runState: session.runState,
      status: session.status,
      messageCount: session.messages.length,
      hasThreadId: session.threadId.trim().length > 0,
    });

    if (session.runState === "running") {
      logSessionRunStuckInvestigation("runtime.admission.rejected", {
        sessionId,
        clientRequestId,
        guard: "stored-run-state",
      });
      throw new Error("This session is already running.");
    }

    if (isReadOnlySession(session)) {
      throw new Error("Read-only sessions cannot send messages. Create a new session.");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("Enter a message before sending.");
    }

    const providerSession = await (this.deps.resolveProviderSession?.(session) ?? session);
    const composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    throwIfRunCanceled(runAbortController.signal);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "Failed to resolve attachment.");
    }

    const appSettings = await this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new Error("This provider is disabled in Settings.");
    }

    const { snapshot, provider } = await this.deps.resolveProviderCatalog(session.provider, request.executionOptions?.catalogRevision);
    if (provider.id !== session.provider) {
      throw new Error("The selected provider does not match this session.");
    }
    const executionOptions = validateSessionExecutionOptions(request.executionOptions, provider, snapshot.revision);
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    let agentRuntimeBinding = await Promise.resolve(
      this.deps.getProviderAgentRuntimeBinding?.({ session, provider }) ?? null,
    );
    const sessionMemory = await this.deps.getSessionMemory(session);
    const projectMemoryEntries = await this.deps.resolveProjectMemoryEntriesForPrompt(session, nextMessage, sessionMemory);
    const sessionCharacter = await this.deps.resolveSessionCharacter?.(session) ?? null;
    const conversationTimingContext = appSettings.conversationTimingEnabled
      ? await Promise.resolve(
        this.deps.resolveConversationTimingContext?.(session, observedAt) ?? null,
      )
      : null;
    const characterContext = appSettings.characterAffectContextEnabled
      ? await Promise.resolve(
        this.deps.resolveCharacterContext?.(session, nextMessage) ?? null,
      )
      : null;
    throwIfRunCanceled(runAbortController.signal);
    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;

    let promptForAudit: ProviderPromptComposition;
    let runningSession: Session;
    let initialLiveState: LiveSessionRunState;
    let runningAuditEntry: CreateAuditLogInput;
    let runningAuditLog: AuditLogEntry;
    let setupLiveRun = false;
    let setupRunningSessionSaved = false;
    try {
      promptForAudit = providerAdapter.composePrompt({
        session: providerSession,
        executionOptions,
        sessionFolderPath: await this.deps.resolveSessionFolderPath?.(providerSession.id),
        sessionMemory,
        projectMemoryEntries,
        character: sessionCharacter ?? undefined,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        conversationTimingContext: conversationTimingContext ?? undefined,
        characterContext: characterContext ?? undefined,
        agentRuntimeBinding,
      });

      runningSession = {
        ...session,
        updatedAt: currentTimestampLabel(),
        status: "running",
        runState: "running",
        messages: [...session.messages, { role: "user", text: nextMessage }],
      };

      const runningUpsertStartedAt = Date.now();
      runningSession = await (
        this.deps.persistRunningTurnStart?.(runningSession, session.messages.length)
        ?? this.deps.upsertSession(runningSession)
      );
      setupRunningSessionSaved = true;
      logSessionRunStuckInvestigation("runtime.running-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - runningUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: runningSession.messages.length,
      });
      throwIfRunCanceled(runAbortController.signal);
      this.inFlightSessionRuns.add(sessionId);
      initialLiveState = {
        ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
        backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
        reasoningText: "",
      };
      this.setRuntimeLiveState(sessionId, initialLiveState);
      setupLiveRun = true;

      runningAuditEntry = buildRunningAuditEntry({
        sessionId,
        createdAt: new Date().toISOString(),
        session: runningSession,
        executionOptions,
        logicalPrompt: promptForAudit.logicalPrompt,
        clientRequestId,
        submitSource: submitSource ?? undefined,
      });
      const runningAuditCreateStartedAt = Date.now();
      runningAuditLog = await this.deps.createAuditLog(runningAuditEntry);
      logSessionRunStuckInvestigation("runtime.running-audit-create.done", {
        sessionId,
        auditLogId: runningAuditLog.id,
        durationMs: Date.now() - runningAuditCreateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
      });
      this.startingSessionRuns.delete(sessionId);
    } catch (error) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      if (setupLiveRun) {
        this.setRuntimeLiveState(sessionId, null);
      }
      if (setupRunningSessionSaved) {
        await Promise.resolve(this.deps.upsertSession({
          ...runningSession!,
          updatedAt: currentTimestampLabel(),
          status: "idle",
          runState: "error",
        })).catch((cleanupError) => {
          console.warn("Session setup failure cleanup failed", cleanupError);
        });
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      throw error;
    }
    let latestObservedRunningAuditEntry = runningAuditEntry;
    let terminalAuditSettled = false;
    let liveProgressGeneration = 0;
    let auditWriteQueue: Promise<void> = Promise.resolve();
    let auditWriteError: unknown = null;
    let auditWritesDetached = false;
    let pendingAuditPatches = 0;
    let pendingAuditPatchChars = 0;
    let auditProgressFailure: unknown = null;
    let auditAdmissionRejected = false;
    const auditOperationIds = new Map<string, number>();
    const observedOperations = new Map<string, AuditLogEntry["operations"][number]>();
    const failAuditProgress = (error: unknown) => {
      auditProgressFailure ??= error;
      if (!terminalAuditSettled) runAbortController.abort(auditProgressFailure);
    };
    const recordAuditProgressFailure = (entry: CreateAuditLogInput) => {
      if (!auditProgressFailure && !auditWriteError) return;
      entry.providerMetadata = [...(entry.providerMetadata ?? []).filter((metadata) => metadata.kind !== "audit_progress_failure" || metadata.source !== "SessionRuntimeService"), {
        provider: activeRunningSession.provider,
        kind: "audit_progress_failure",
        source: "SessionRuntimeService",
        summary: "Audit progress persistence did not complete successfully",
        payload: {
          admissionRejected: auditAdmissionRejected,
          acceptedProgressPersistence: auditWriteError ? "failed" : pendingAuditPatches > 0 ? "pending" : "completed",
        },
      }];
    };

    let activeRunningSession = runningSession;
    if (runningSession.provider === "codex") this.appendSessionInput.set(sessionId, async (text) => {
      activeRunningSession = { ...activeRunningSession, updatedAt: currentTimestampLabel(), messages: [...activeRunningSession.messages, { role: "user", text }] };
      activeRunningSession = await this.deps.upsertSession(activeRunningSession);
      this.deps.broadcastLiveSessionRun(sessionId);
    });
    const enqueueAuditWrite = (
      patch: AuditLogProgressPatch,
      removedKeys: string[],
    ): Promise<void> => {
      // Include retained removal keys and a conservative allowance for IDs added on dispatch.
      const chars = JSON.stringify({ patch, removedKeys }).length
        + ((patch.operationUpserts?.length ?? 0) + removedKeys.length) * 32;
      if (pendingAuditPatches >= MAX_PENDING_AUDIT_PATCHES || pendingAuditPatchChars + chars > MAX_PENDING_AUDIT_PATCH_CHARS) {
        const error = new Error("Audit progress persistence capacity exceeded");
        auditAdmissionRejected = true;
        failAuditProgress(error);
        return Promise.reject(error);
      }
      pendingAuditPatches += 1;
      pendingAuditPatchChars += chars;
      const write = auditWriteQueue
        .then(async () => {
          if (auditWriteError) throw new Error("Audit progress dispatch stopped after an unsuccessful write", { cause: auditWriteError });
          const operationUpserts = patch.operationUpserts?.map((upsert) => ({ ...upsert, outputId: auditOperationIds.get(upsert.key) }));
          const operationRemoves = removedKeys.flatMap((key) => {
            const id = auditOperationIds.get(key);
            return id === undefined ? [] : [id];
          });
          const ack = await this.deps.updateAuditLogProgress(runningAuditLog.id, { ...patch, operationUpserts, operationRemoves });
          for (const inserted of ack.insertedOperations) auditOperationIds.set(inserted.key, inserted.outputId);
          for (const key of removedKeys) auditOperationIds.delete(key);
        });
      auditWriteQueue = write.catch((error) => {
        auditWriteError ??= error;
        failAuditProgress(error);
      }).finally(() => {
        pendingAuditPatches -= 1;
        pendingAuditPatchChars -= chars;
      });
      return write;
    };
    const flushAuditWrites = async (allowDetached = false): Promise<boolean> => {
      if (auditWritesDetached) {
        return false;
      }
      let observedQueue: Promise<void>;
      do {
        observedQueue = auditWriteQueue;
        const flushResult = await waitForAuditEnrichment(
          observedQueue,
          this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
        );
        if (flushResult === AUDIT_ENRICHMENT_TIMEOUT) {
          auditWritesDetached = true;
          logSessionRunStuckInvestigation("runtime.audit-flush.timeout", {
            sessionId,
            timeoutMs: this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
          });
          if (!allowDetached) {
            throw new Error("Audit progress persistence exceeded its grace period");
          }
          return false;
        }
      } while (observedQueue !== auditWriteQueue);
      if (auditWriteError) {
        throw auditWriteError;
      }
      return true;
    };
    const syncRunningAuditFromLiveState = async (nextLiveState: LiveSessionRunState, changes: RunSessionTurnProgressChanges = {
      steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] },
    }) => {
      if (terminalAuditSettled) {
        return;
      }
      if (auditProgressFailure) throw auditProgressFailure;
      this.setRuntimeLiveState(sessionId, nextLiveState);
      const patch: AuditLogProgressPatch = { sessionId, observedAt: new Date().toISOString() };
      const threadId = pickPreferredThreadId(
        nextLiveState.threadId,
        latestObservedRunningAuditEntry.threadId,
        activeRunningSession.threadId,
      );
      const assistantText = nextLiveState.assistantText.trim()
        ? toAuditTextPreview(nextLiveState.assistantText) ?? ""
        : latestObservedRunningAuditEntry.assistantText;
      const errorMessage = nextLiveState.errorMessage.trim()
        ? toAuditTextPreview(nextLiveState.errorMessage) ?? ""
        : latestObservedRunningAuditEntry.errorMessage;
      if (threadId !== latestObservedRunningAuditEntry.threadId || errorMessage !== latestObservedRunningAuditEntry.errorMessage) {
        patch.fields = {
          ...(threadId !== latestObservedRunningAuditEntry.threadId ? { threadId } : {}),
          ...(errorMessage !== latestObservedRunningAuditEntry.errorMessage ? { errorMessage } : {}),
        };
      }
      if (assistantText !== latestObservedRunningAuditEntry.assistantText) patch.assistantSnapshot = { body: assistantText };
      const previousUsage = latestObservedRunningAuditEntry.usage;
      const usage = nextLiveState.usage;
      if (usage && (!previousUsage || usage.inputTokens !== previousUsage.inputTokens
        || usage.cachedInputTokens !== previousUsage.cachedInputTokens || usage.outputTokens !== previousUsage.outputTokens
        || usage.reasoningOutputTokens !== previousUsage.reasoningOutputTokens || usage.totalTokens !== previousUsage.totalTokens)) patch.usage = usage;
      const upserts: NonNullable<AuditLogProgressPatch["operationUpserts"]> = [];
      const addOperation = (key: string, operation: AuditLogEntry["operations"][number]) => {
        const previous = observedOperations.get(key);
        if (!previous || previous.type !== operation.type || previous.summary !== operation.summary || previous.details !== operation.details) {
          upserts.push({ key, operation });
        }
      };
      const removedKeys = [...changes.steps.removes.map((id) => `step:${id}`), ...changes.backgroundTasks.removes.map((id) => `background:${id}`)];
      for (const step of changes.steps.upserts) {
        const operation = buildLiveRunAuditOperations({ steps: [step], backgroundTasks: [], approvalRequest: null, elicitationRequest: null })[0]!;
        addOperation(`step:${step.id}`, operation);
      }
      for (const task of changes.backgroundTasks.upserts) {
        const operation = buildLiveRunAuditOperations({ steps: [], backgroundTasks: [task], approvalRequest: null, elicitationRequest: null })[0]!;
        addOperation(`background:${task.id}`, operation);
      }
      for (const [key, request] of [["approval", nextLiveState.approvalRequest], ["elicitation", nextLiveState.elicitationRequest]] as const) {
        if (request) {
          const operation = buildLiveRunAuditOperations({ steps: [], backgroundTasks: [], approvalRequest: key === "approval" ? nextLiveState.approvalRequest : null, elicitationRequest: key === "elicitation" ? nextLiveState.elicitationRequest : null })[0]!;
          addOperation(key, operation);
        } else if (observedOperations.has(key)) removedKeys.push(key);
      }
      if (upserts.length) patch.operationUpserts = upserts;
      if (!patch.fields && !patch.assistantSnapshot && !patch.usage && !upserts.length && !removedKeys.length) return;
      const write = enqueueAuditWrite(patch, removedKeys);
      // Observation follows admission, not persistence. A rejected admission terminates this turn.
      if (!auditProgressFailure) {
        latestObservedRunningAuditEntry = { ...latestObservedRunningAuditEntry, threadId, assistantText, errorMessage, usage: nextLiveState.usage ?? latestObservedRunningAuditEntry.usage };
        for (const upsert of upserts) observedOperations.set(upsert.key, upsert.operation);
        for (const key of removedKeys) observedOperations.delete(key);
      }
      // Admission is bounded, but storage latency must not block provider control events.
      void write.catch(() => undefined);
      if (auditProgressFailure) throw auditProgressFailure;
    };
    await syncRunningAuditFromLiveState(initialLiveState, {
      steps: { upserts: initialLiveState.steps, removes: [] },
      backgroundTasks: { upserts: initialLiveState.backgroundTasks, removes: [] },
    }).catch(failAuditProgress);
    const runProviderTurn = async (turnSession: Session) => {
      const progressGeneration = ++liveProgressGeneration;
      const effectiveTurnSession = await (this.deps.resolveProviderSession?.(turnSession) ?? turnSession);
      const providerPromise = providerAdapter.runSessionTurn({
        session: effectiveTurnSession,
        executionOptions,
        sessionFolderPath: await this.deps.resolveSessionFolderPath?.(effectiveTurnSession.id),
        sessionMemory,
        projectMemoryEntries,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        conversationTimingContext: conversationTimingContext ?? undefined,
        characterContext: characterContext ?? undefined,
        agentRuntimeBinding,
        signal: runAbortController.signal,
        onCleanupPending: (completion) => this.trackTerminatingSessionRun(sessionId, completion),
        onApprovalRequest: (approvalRequest, requestSignal) => {
          if (terminalAuditSettled || progressGeneration !== liveProgressGeneration || auditProgressFailure) return "deny";
          const signal = requestSignal ? AbortSignal.any([runAbortController.signal, requestSignal]) : runAbortController.signal;
          const decision = this.deps.waitForApprovalDecision(sessionId, approvalRequest, signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          void syncRunningAuditFromLiveState({
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId)),
            approvalRequest,
            elicitationRequest: currentLiveState?.elicitationRequest ?? null,
          }).catch((error) => {
            console.warn("Audit progress update failed", error);
          });
          return decision;
        },
        onElicitationRequest: (elicitationRequest, requestSignal) => {
          if (terminalAuditSettled || progressGeneration !== liveProgressGeneration || auditProgressFailure) return { action: "cancel" };
          const signal = requestSignal ? AbortSignal.any([runAbortController.signal, requestSignal]) : runAbortController.signal;
          const response = this.deps.waitForElicitationResponse(sessionId, elicitationRequest, signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          void syncRunningAuditFromLiveState({
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId)),
            approvalRequest: currentLiveState?.approvalRequest ?? null,
            elicitationRequest,
          }).catch((error) => {
            console.warn("Audit progress update failed", error);
          });
          return response;
        },
        onProviderQuotaTelemetry: (telemetry) => {
          this.deps.setProviderQuotaTelemetry(telemetry);
        },
        onSessionContextTelemetry: (telemetry) => {
          this.deps.setSessionContextTelemetry(telemetry);
        },
      }, (state, changes) => {
        if (terminalAuditSettled || progressGeneration !== liveProgressGeneration) {
          return;
        }

        const currentLiveState = this.deps.getLiveSessionRun(sessionId);
        const nextLiveState: LiveSessionRunState = {
          ...state,
          reasoningText: state.reasoningText ?? currentLiveState?.reasoningText ?? "",
          approvalRequest: currentLiveState?.approvalRequest ?? null,
          elicitationRequest: currentLiveState?.elicitationRequest ?? null,
        };
        return syncRunningAuditFromLiveState(nextLiveState, changes);
      });
      try {
        return await waitForProviderTurnWithCancelDeadline(
        providerPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () => buildCanceledPartialResult(this.deps.getLiveSessionRun(sessionId), promptForAudit),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
        );
      } finally {
        this.finishingSessionTurns.add(sessionId);
        const live = this.deps.getLiveSessionRun(sessionId);
        if (live?.inputAvailable) {
          this.setRuntimeLiveState(sessionId, { ...live, inputAvailable: false });
          this.deps.broadcastLiveSessionRun(sessionId);
        }
        const pendingInput = this.pendingSessionInputs.get(sessionId);
        if (pendingInput && this.dispatchedSessionInputs.has(sessionId)) await pendingInput.catch(() => undefined);
        else if (pendingInput) this.pendingSessionInputs.delete(sessionId);
      }
    };

    let providerAgentRuntimeTurnHandle: unknown;
    try {
      const providerAgentRuntimeTurn = await Promise.resolve(
        this.deps.beginProviderAgentRuntimeTurn?.({
          session: activeRunningSession,
          provider,
          binding: agentRuntimeBinding,
        }),
      );
      providerAgentRuntimeTurnHandle = providerAgentRuntimeTurn?.handle;
      if (providerAgentRuntimeTurn) {
        agentRuntimeBinding = providerAgentRuntimeTurn.binding;
      }
      let result: RunSessionTurnResult | null = null;
      let didInternalRetry = false;
      while (true) {
        try {
          result = await runProviderTurn(activeRunningSession);
          logSessionRunStuckInvestigation("runtime.provider-turn.done", {
            sessionId,
            clientRequestId,
            elapsedMs: Date.now() - investigationStartedAt,
            assistantChars: result.assistantText.length,
            operationCount: result.operations.length,
            rawItemsChars: result.rawItemsJson.length,
            hasThreadId: (result.threadId ?? "").trim().length > 0,
          });
          break;
        } catch (error) {
          const providerTurnError = error instanceof ProviderTurnError ? error : null;
          const shouldRetry =
            !auditProgressFailure &&
            activeRunningSession.provider !== "codex" &&
            !didInternalRetry &&
            !isCanceledRunError(error) &&
            !(await this.deps.isAuxiliarySession?.(sessionId)) &&
            shouldRetryUnusableThreadRun(error, providerTurnError?.partialResult);

          if (!shouldRetry) {
            throw error;
          }

          didInternalRetry = true;
          liveProgressGeneration += 1;
          if (this.deps.resetProviderSessionThread) {
            await Promise.resolve(this.deps.resetProviderSessionThread(activeRunningSession.provider, sessionId));
          } else {
            await Promise.resolve(this.deps.invalidateProviderSessionThread(activeRunningSession.provider, sessionId));
          }
          if (activeRunningSession.threadId) {
            activeRunningSession = await this.deps.upsertSession({
              ...activeRunningSession,
              threadId: "",
              updatedAt: currentTimestampLabel(),
            });
          }
          this.setRuntimeLiveState(sessionId, {
            ...buildEmptyLiveSessionRunState(sessionId, ""),
            backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
          });
          const resetAuditEntry = buildRunningAuditEntry({
            sessionId,
            createdAt: runningAuditLog.createdAt,
            session: activeRunningSession,
            executionOptions,
            logicalPrompt: promptForAudit.logicalPrompt,
            threadId: "",
            clientRequestId,
            submitSource: submitSource ?? undefined,
          });
          await flushAuditWrites();
          runningAuditEntry = resetAuditEntry;
          latestObservedRunningAuditEntry = resetAuditEntry;
          observedOperations.clear();
          auditOperationIds.clear();
          await this.deps.updateAuditLog(runningAuditLog.id, runningAuditEntry);
        }
      }
      if (!result) {
        throw new Error("The provider did not return a completed turn.");
      }
      if (auditProgressFailure) throw new ProviderTurnError(String(auditProgressFailure), result, false);
      latestObservedRunningAuditEntry = { ...latestObservedRunningAuditEntry, operations: [...observedOperations.values()] };

      const completedAt = new Date().toISOString();

      terminalAuditSettled = true;
      const completedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: "idle",
        threadId: result.threadId ?? activeRunningSession.threadId,
        messages: [
          ...activeRunningSession.messages,
          {
            role: "assistant",
            text: result.assistantText,
            artifact: result.artifact,
          },
        ],
      };
      const affectTurnCorrelationId = `turn:${sessionId}:audit:${runningAuditLog.id}`;
      const assistantMessageIndex = completedSession.messages.length - 1;
      const requiresDurableAppraisal = this.deps.requireDurableCompletedTurnAppraisal === true
        && completedSession.sessionKind === "default"
        && Boolean(completedSession.characterId);
      if (
        requiresDurableAppraisal
        && (!this.deps.queueCompletedTurnAppraisal || !this.deps.markCompletedTurnAppraisalReady)
      ) {
        throw new Error("Default Character Session requires durable affect turn settlement before completion.");
      }
      if (this.deps.queueCompletedTurnAppraisal) {
        await this.deps.queueCompletedTurnAppraisal({
          session: completedSession,
          correlationId: affectTurnCorrelationId,
          userMessage: nextMessage,
          assistantMessage: result.assistantText,
          assistantMessageIndex,
          occurredAt: completedAt,
        });
      }

      const completedSessionUpsertStartedAt = Date.now();
      const completedThreadId = pickPreferredThreadId(result.threadId, completedSession.threadId);
      const storedCompletedSession = await this.upsertTerminalSession(completedSession, {
        auditLogId: runningAuditLog.id,
        sessionId,
        phase: "completed",
        assistantMessageSeq: assistantMessageIndex,
        threadId: completedThreadId,
        errorMessage: "",
        completedAt,
      }, {
        confirmedFinalAssistantText: result.lastNonEmptyAssistantMessageText,
      });
      logSessionRunStuckInvestigation("runtime.completed-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - completedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: completedSession.messages.length,
        storedRunState: storedCompletedSession.runState,
        storedStatus: storedCompletedSession.status,
      });
      activeRunningSession = storedCompletedSession;
      if (!runAbortController.signal.aborted) {
        notifySessionTurnTerminalBestEffort(this.deps.notifySessionTurnTerminal, {
          outcome: "completed",
          session: storedCompletedSession,
          lastNonEmptyAssistantMessageText: result.lastNonEmptyAssistantMessageText ?? "",
        });
      }
      completeCompletedTurnAppraisalBestEffort(
        requiresDurableAppraisal ? this.deps.markCompletedTurnAppraisalReady : undefined,
        this.deps.appraiseCompletedTurn,
        affectTurnCorrelationId,
        this.deps.appraisalReadyRetryMs ?? DEFAULT_APPRAISAL_READY_RETRY_MS,
      );

      const completeCompletedAudit = async (): Promise<void> => {
        const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
        const logicalPromptEstimate = estimateLogicalPromptTokens(result.logicalPrompt);
        const completedAuditEntry = buildTerminalAuditEntry({
          baseEntry: latestObservedRunningAuditEntry,
          phase: "completed",
          completedAt,
          session: storedCompletedSession,
          executionOptions,
          threadId: completedThreadId,
          logicalPrompt: result.logicalPrompt,
          transportPayload: appendTransportPayloadFields(
            appendQuotaTelemetryToTransportPayload(
              ensureAuditTransportPayload(result.transportPayload),
              result.providerQuotaTelemetry,
            ),
            [
              { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
              { label: "promptEstimatedChars", value: String(logicalPromptEstimate.composed.charCount) },
              { label: "promptEstimatedTokens", value: String(logicalPromptEstimate.composed.estimatedTokens) },
              { label: "promptSystemEstimatedChars", value: String(logicalPromptEstimate.system.charCount) },
              { label: "promptSystemEstimatedTokens", value: String(logicalPromptEstimate.system.estimatedTokens) },
              { label: "promptInputEstimatedChars", value: String(logicalPromptEstimate.input.charCount) },
              { label: "promptInputEstimatedTokens", value: String(logicalPromptEstimate.input.estimatedTokens) },
              { label: "projectMemoryHits", value: String(projectMemoryEntries.length) },
              { label: "attachmentCount", value: String(composerPreview.attachments.length) },
            ],
          ),
          assistantText: result.assistantText,
          operations: result.operations,
          rawItemsJson: result.rawItemsJson,
          providerMetadata: result.providerMetadata,
          usage: result.usage,
          assistantMessageSeq: assistantMessageIndex,
          errorMessage: "",
        });
        const flushAuditStartedAt = Date.now();
        let auditWritesDrained = false;
        try {
          auditWritesDrained = await flushAuditWrites(true);
        } catch (auditFlushError) {
          console.warn("Detached completed audit flush failed", auditFlushError);
        }
        logSessionRunStuckInvestigation("runtime.audit-flush.done", {
          sessionId,
          durationMs: Date.now() - flushAuditStartedAt,
          elapsedMs: Date.now() - investigationStartedAt,
          terminalPhase: "completed",
        });
        recordAuditProgressFailure(completedAuditEntry);
        const completedAuditUpdateStartedAt = Date.now();
        try {
          if (!auditWritesDrained) {
            void auditWriteQueue
              .then(() => {
                recordAuditProgressFailure(completedAuditEntry);
                return this.deps.updateAuditLog(runningAuditLog.id, completedAuditEntry);
              })
              .catch((error) => console.warn("Detached completed audit update failed", error));
            return;
          }
          const completedAuditUpdateResult = await waitForAuditEnrichment(
            Promise.resolve(this.deps.updateAuditLog(runningAuditLog.id, completedAuditEntry)),
            this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
          );
          if (completedAuditUpdateResult === AUDIT_ENRICHMENT_TIMEOUT) {
            logSessionRunStuckInvestigation("runtime.completed-audit-update.timeout", {
              sessionId,
              auditLogId: runningAuditLog.id,
              timeoutMs: this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
            });
            return;
          }
          logSessionRunStuckInvestigation("runtime.completed-audit-update.done", {
            sessionId,
            auditLogId: runningAuditLog.id,
            durationMs: Date.now() - completedAuditUpdateStartedAt,
            elapsedMs: Date.now() - investigationStartedAt,
            operationCount: completedAuditEntry.operations.length,
          });
          runningAuditEntry = completedAuditEntry;
        } catch (auditUpdateError: unknown) {
          logSessionRunStuckInvestigation("runtime.completed-audit-update.failed", {
            sessionId,
            auditLogId: runningAuditLog.id,
            durationMs: Date.now() - completedAuditUpdateStartedAt,
            elapsedMs: Date.now() - investigationStartedAt,
            message: auditUpdateError instanceof Error ? auditUpdateError.message : String(auditUpdateError),
            operationCount: completedAuditEntry.operations.length,
          });
          const degradedAuditEntry = buildDegradedCompletedAuditEntry({
            completedAuditEntry,
            auditUpdateError,
            completedAt,
          });
          const degradedAuditUpdateStartedAt = Date.now();
          try {
            const degradedAuditUpdateResult = await waitForAuditEnrichment(
              Promise.resolve(this.deps.updateAuditLog(runningAuditLog.id, degradedAuditEntry)),
              this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
            );
            if (degradedAuditUpdateResult === AUDIT_ENRICHMENT_TIMEOUT) {
              logSessionRunStuckInvestigation("runtime.completed-audit-update.degraded-timeout", {
                sessionId,
                auditLogId: runningAuditLog.id,
                timeoutMs: this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
              });
              return;
            }
            logSessionRunStuckInvestigation("runtime.completed-audit-update.degraded", {
              sessionId,
              auditLogId: runningAuditLog.id,
              durationMs: Date.now() - degradedAuditUpdateStartedAt,
              elapsedMs: Date.now() - investigationStartedAt,
            });
            runningAuditEntry = degradedAuditEntry;
          } catch (degradedAuditUpdateError: unknown) {
            logSessionRunStuckInvestigation("runtime.completed-audit-update.degraded-failed", {
              sessionId,
              auditLogId: runningAuditLog.id,
              durationMs: Date.now() - degradedAuditUpdateStartedAt,
              elapsedMs: Date.now() - investigationStartedAt,
              message: degradedAuditUpdateError instanceof Error
                ? degradedAuditUpdateError.message
                : String(degradedAuditUpdateError),
            });
          }
        }
      };
      runInBackgroundMacrotask("Detached completed audit processing failed", completeCompletedAudit);
      return storedCompletedSession;
    } catch (error: unknown) {
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = !auditProgressFailure && (providerTurnError ? providerTurnError.canceled : isCanceledRunError(error));
      const effectiveError = auditProgressFailure ?? error;
      const message = effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
      latestObservedRunningAuditEntry = { ...latestObservedRunningAuditEntry, operations: [...observedOperations.values()] };
      const providerErrorReason = auditProgressFailure ? "unknown" : providerTurnError?.reason ?? null;
      const failureMessage = formatProviderFailureMessage({
        providerId: activeRunningSession.provider,
        reason: providerErrorReason,
        message,
        canceled,
      });
      const partialResult = providerTurnError?.partialResult;
      const failedAuditThreadId = pickPreferredThreadId(
        partialResult?.threadId,
        latestObservedRunningAuditEntry.threadId,
        this.deps.getLiveSessionRun(sessionId)?.threadId,
        activeRunningSession.threadId,
      );
      const shouldResetFailedThread = !auditProgressFailure && activeRunningSession.provider !== "codex" && shouldResetFailedSessionThread(
        error,
        activeRunningSession.threadId,
        partialResult,
        canceled,
      );
      const nextSessionThreadId = activeRunningSession.provider === "codex" && activeRunningSession.threadId
        ? activeRunningSession.threadId
        : shouldResetFailedThread ? "" : failedAuditThreadId;
      const completedAt = new Date().toISOString();
      const failedLogicalPrompt = partialResult?.logicalPrompt ?? promptForAudit.logicalPrompt;

      terminalAuditSettled = true;
      const completeFailedAudit = async (): Promise<void> => {
        const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
        const failedLogicalPromptEstimate = estimateLogicalPromptTokens(failedLogicalPrompt);
        const failedAuditEntry = buildTerminalAuditEntry({
          baseEntry: latestObservedRunningAuditEntry,
          phase: canceled ? "canceled" : "failed",
          completedAt,
          session: storedFailedSession,
          executionOptions,
          threadId: failedAuditThreadId,
          logicalPrompt: failedLogicalPrompt,
          transportPayload: appendTransportPayloadFields(
            appendQuotaTelemetryToTransportPayload(
              ensureAuditTransportPayload(partialResult?.transportPayload ?? null),
              partialResult?.providerQuotaTelemetry,
            ),
            [
              { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
              { label: "promptEstimatedChars", value: String(failedLogicalPromptEstimate.composed.charCount) },
              { label: "promptEstimatedTokens", value: String(failedLogicalPromptEstimate.composed.estimatedTokens) },
              { label: "promptSystemEstimatedChars", value: String(failedLogicalPromptEstimate.system.charCount) },
              { label: "promptSystemEstimatedTokens", value: String(failedLogicalPromptEstimate.system.estimatedTokens) },
              { label: "promptInputEstimatedChars", value: String(failedLogicalPromptEstimate.input.charCount) },
              { label: "promptInputEstimatedTokens", value: String(failedLogicalPromptEstimate.input.estimatedTokens) },
              { label: "projectMemoryHits", value: String(projectMemoryEntries.length) },
              { label: "attachmentCount", value: String(composerPreview.attachments.length) },
            ],
          ),
          assistantText: partialResult?.assistantText ?? "",
          operations: partialResult?.operations ?? [],
          rawItemsJson: partialResult?.rawItemsJson ?? "[]",
          providerMetadata: partialResult?.providerMetadata,
          usage: partialResult?.usage ?? null,
          assistantMessageSeq: storedFailedSession.messages.length - 1,
          errorMessage: failureMessage,
        });
        const failedFlushAuditStartedAt = Date.now();
        let auditWritesDrained = false;
        try {
          auditWritesDrained = await flushAuditWrites(true);
        } catch (auditFlushError) {
          console.warn("Detached terminal audit flush failed", auditFlushError);
        }
        logSessionRunStuckInvestigation("runtime.audit-flush.done", {
          sessionId,
          durationMs: Date.now() - failedFlushAuditStartedAt,
          elapsedMs: Date.now() - investigationStartedAt,
          terminalPhase: canceled ? "canceled" : "failed",
        });
        recordAuditProgressFailure(failedAuditEntry);
        const failedAuditUpdateStartedAt = Date.now();
        if (auditWritesDrained) {
          const failedAuditUpdateResult = await waitForAuditEnrichment(
            Promise.resolve(this.deps.updateAuditLog(runningAuditLog.id, failedAuditEntry)),
            this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
          );
          if (failedAuditUpdateResult !== AUDIT_ENRICHMENT_TIMEOUT) {
            logSessionRunStuckInvestigation("runtime.terminal-audit-update.done", {
              sessionId,
              auditLogId: runningAuditLog.id,
              durationMs: Date.now() - failedAuditUpdateStartedAt,
              elapsedMs: Date.now() - investigationStartedAt,
              phase: failedAuditEntry.phase,
              operationCount: failedAuditEntry.operations.length,
            });
            runningAuditEntry = failedAuditEntry;
          } else {
            logSessionRunStuckInvestigation("runtime.terminal-audit-update.timeout", {
              sessionId,
              auditLogId: runningAuditLog.id,
              timeoutMs: this.deps.auditEnrichmentGraceMs ?? DEFAULT_AUDIT_ENRICHMENT_GRACE_MS,
            });
          }
        } else {
          void auditWriteQueue
            .then(() => {
              recordAuditProgressFailure(failedAuditEntry);
              return this.deps.updateAuditLog(runningAuditLog.id, failedAuditEntry);
            })
            .catch((auditError) => console.warn("Detached terminal audit update failed", auditError));
        }
      };
      const fallbackNotice = formatProviderFailureNotice({
        providerId: activeRunningSession.provider,
        reason: providerErrorReason,
        message,
        canceled,
      });
      const assistantText = partialResult?.assistantText.trim()
        ? `${partialResult.assistantText}\n\n${fallbackNotice}`
        : fallbackNotice;
      const failedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: canceled ? "idle" : "error",
        threadId: nextSessionThreadId,
        messages: [
          ...activeRunningSession.messages,
          {
            role: "assistant",
            text: assistantText,
            artifact: partialResult?.artifact,
            accent: true,
          },
        ],
      };

      const failedSessionUpsertStartedAt = Date.now();
      const storedFailedSession = await this.upsertTerminalSession(failedSession, {
        auditLogId: runningAuditLog.id,
        sessionId,
        phase: canceled ? "canceled" : "failed",
        assistantMessageSeq: failedSession.messages.length - 1,
        threadId: failedAuditThreadId,
        errorMessage: failureMessage,
        completedAt,
      });
      logSessionRunStuckInvestigation("runtime.terminal-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - failedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: failedSession.messages.length,
        storedRunState: storedFailedSession.runState,
        storedStatus: storedFailedSession.status,
      });
      activeRunningSession = storedFailedSession;
      if (!canceled && !this.pendingSessionRunCancels.has(sessionId)
        && (!runAbortController.signal.aborted || runAbortController.signal.reason === auditProgressFailure)) {
        notifySessionTurnTerminalBestEffort(this.deps.notifySessionTurnTerminal, {
          outcome: "failed",
          session: storedFailedSession,
        });
      }
      invalidateProviderSessionThreadBestEffort(
        this.deps.invalidateProviderSessionThread,
        storedFailedSession.provider,
        sessionId,
      );
      runInBackgroundMacrotask("Detached terminal audit processing failed", completeFailedAudit);
      return storedFailedSession;
    } finally {
      this.appendSessionInput.delete(sessionId);
      if (providerAgentRuntimeTurnHandle !== undefined) {
        this.deps.endProviderAgentRuntimeTurn?.(providerAgentRuntimeTurnHandle);
      }
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      const currentLiveState = this.deps.getLiveSessionRun(sessionId);
      this.finishingSessionTurns.delete(sessionId);
      const preservedBackgroundTasks = currentLiveState?.backgroundTasks ?? [];
      const preservedReasoningText = currentLiveState?.reasoningText ?? "";
      if (preservedBackgroundTasks.length > 0 || preservedReasoningText.trim().length > 0) {
        this.setRuntimeLiveState(sessionId, {
          ...buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId),
          backgroundTasks: preservedBackgroundTasks,
          reasoningText: preservedReasoningText,
        });
      } else {
        this.setRuntimeLiveState(sessionId, null);
      }
      this.deps.broadcastLiveSessionRun(sessionId);
      logSessionRunStuckInvestigation("runtime.finally.done", {
        sessionId,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        activeRunState: activeRunningSession.runState,
        activeStatus: activeRunningSession.status,
        preservedBackgroundTaskCount: preservedBackgroundTasks.length,
        preservedReasoningChars: preservedReasoningText.length,
        liveRunAfterFinally: this.deps.getLiveSessionRun(sessionId) ? "present" : "null",
      });
    }
  }

}
