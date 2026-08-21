import {
  currentTimestampLabel as defaultCurrentTimestampLabel,
  type AuditLogEntry,
  type ComposerPreview,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
  type LiveSessionRunState,
  type MessageArtifact,
  type ProviderQuotaTelemetry,
  type ProjectMemoryEntry,
  type RunSessionTurnRequest,
  type SessionTurnAttachmentReference,
  type SessionContextTelemetry,
  type SessionMemory,
} from "../src/app-state.js";
import { normalizeSessionTurnCorrelation } from "../src/runtime-state.js";
import { type CharacterProfile } from "../src/character-state.js";
import { buildLiveRunAuditOperations } from "../src/live-run-audit-operations.js";
import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import { isReadOnlySession, type Session } from "../src/session-state.js";
import {
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type { MateStorageState } from "../src/mate/mate-state.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type ProviderPromptComposition,
  type RunSessionTurnResult,
} from "./provider-runtime.js";
import { appendQuotaTelemetryToTransportPayload } from "./audit-log-quota.js";
import { appendTransportPayloadFields, calculateAuditDurationMs } from "./audit-log-metadata.js";
import { estimateLogicalPromptTokens } from "./prompt-token-estimate.js";
import { toAuditTextPreview } from "./audit-payload-limits.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ConversationTimingContext } from "./conversation-timing.js";
import type { CharacterContextResponse } from "../src/character-context/character-context-contract.js";
import { SessionTurnValidationError } from "./session-turn-validation-error.js";
import type { PublicTranscriptAttachmentV1, PublicTranscriptTurnOptionsV1 } from "../src/session-transcript.js";
import {
  createSessionAttachmentSnapshot,
  SessionAttachmentSnapshotLimitError,
} from "./session-attachment-snapshot.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import {
  resolveWorkspaceDirectoryValidationMessage,
  type WorkspaceDirectoryValidationResult,
} from "../src/workspace-directory-validation.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";
const DEFAULT_PROVIDER_CANCEL_GRACE_MS = 10_000;
const DEFAULT_AUDIT_ENRICHMENT_GRACE_MS = 5_000;
const DEFAULT_APPRAISAL_READY_RETRY_MS = 1_000;
const AUDIT_ENRICHMENT_TIMEOUT = Symbol("audit-enrichment-timeout");

export type ExternalSessionTurnResult = {
  session: Session;
  terminalState: "completed" | "canceled" | "failed";
};

function applyTurnRuntimeOptions(session: Session, request: RunSessionTurnRequest): Session {
  return {
    ...session,
    model: request.model?.trim() || session.model,
    reasoningEffort: request.reasoningEffort ?? session.reasoningEffort,
    approvalMode: request.approvalMode ?? session.approvalMode,
    codexSandboxMode: request.codexSandboxMode ?? session.codexSandboxMode,
    customAgentName: request.customAgentName ?? session.customAgentName,
  };
}

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

export type SessionRuntimeServiceDeps = {
  includeNormalSessionRoleContext?: boolean;
  getSession(sessionId: string): Awaitable<Session | null>;
  upsertSession(session: Session): Awaitable<Session>;
  upsertTerminalSession?(session: Session, terminalCommit: SessionTurnTerminalCommit): Awaitable<Session>;
  resolveRuntimeSessionForTurn?: (session: Session) => Awaitable<Session>;
  validateWorkspaceDirectory?: (targetPath: unknown) => Promise<WorkspaceDirectoryValidationResult>;
  resolveComposerPreview(
    session: Session,
    userMessage: string,
    scope?: "workspace" | "session-folder",
  ): Promise<ComposerPreview>;
  resolveSessionFolderAttachments?: (
    session: Session,
    attachments: SessionTurnAttachmentReference[],
  ) => Promise<ComposerPreview>;
  attachmentSnapshotNamespacePath?: string;
  registerExternalApprovalInteraction?: (input: {
    sessionId: string;
    executionId: string;
    request: LiveApprovalRequest;
    signal: AbortSignal;
  }) => Promise<LiveApprovalDecision> | LiveApprovalDecision;
  registerExternalElicitationInteraction?: (input: {
    sessionId: string;
    executionId: string;
    request: LiveElicitationRequest;
    signal: AbortSignal;
  }) => Promise<LiveElicitationResponse> | LiveElicitationResponse;
  publishExternalProgress?: (input: {
    executionId: string;
    assistantText: string;
    updatedAt: string;
  }) => void;
  notifyExecutionUserMessagePersisted?: (sessionId: string, executionId: string) => void;
  persistExternalTurnContext?: (input: {
    turnId: number;
    sessionId: string;
    executionId: string;
    effectiveOptions: PublicTranscriptTurnOptionsV1;
    attachments: readonly PublicTranscriptAttachmentV1[];
    createdAt: string;
    updatedAt: string;
  }) => Awaitable<void>;
  resolveProviderSession?: (session: Session) => Session;
  resolveSessionFolderPath?: (sessionId: string) => string;
  resolveSessionCharacter?: (session: Session) => Promise<CharacterProfile | null>;
  getAppSettings: () => AppSettings;
  resolveProviderCatalog(providerId: string | null | undefined, revision?: number | null): {
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  };
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
  isSessionCustomAgentAvailable?: (workspacePath: string, customAgentName: string) => Promise<boolean>;
  getSessionMemory(session: Session): SessionMemory;
  resolveProjectMemoryEntriesForPrompt(
    session: Session,
    userMessage: string,
    sessionMemory: SessionMemory,
  ): ProjectMemoryEntry[];
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
  appraiseCompletedTurn?: (input: {
    session: Session;
    correlationId: string;
    userMessage: string;
    assistantMessage: string;
    assistantMessageIndex: number;
    occurredAt: string;
  }) => Awaitable<void>;
  createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLog(id: number, entry: CreateAuditLogInput): Awaitable<void | AuditLogEntry>;
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
  getProviderAgentRuntimeBinding?(input: {
    session: Session;
    provider: ModelCatalogProvider;
  }): Awaitable<ProviderAgentRuntimeBindingProjection | null>;
  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void;
  broadcastLiveSessionRun(sessionId: string): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
  resolvePendingElicitationRequest(sessionId: string, response: LiveElicitationResponse): void;
  getMateState?: () => MateStorageState;
  notifySessionTurnCompleted?: (session: Session, lastNonEmptyAssistantMessageText: string) => Awaitable<void>;
  onSessionRunAvailable?: (sessionId: string) => Awaitable<void>;
  currentTimestampLabel?: () => string;
  currentDate?: () => Date;
  providerCancelGraceMs?: number;
  auditEnrichmentGraceMs?: number;
  appraisalReadyRetryMs?: number;
};

function notifySessionTurnCompletedBestEffort(
  notify: SessionRuntimeServiceDeps["notifySessionTurnCompleted"],
  session: Session,
  lastNonEmptyAssistantMessageText: string,
): void {
  if (!notify) {
    return;
  }

  try {
    void Promise.resolve(notify(session, lastNonEmptyAssistantMessageText))
      .catch((error) => console.warn("Session turn completion notification failed", error));
  } catch (error) {
    console.warn("Session turn completion notification failed", error);
  }
}

function notifyExecutionUserMessagePersistedBestEffort(
  notify: SessionRuntimeServiceDeps["notifyExecutionUserMessagePersisted"],
  sessionId: string,
  executionId: string,
): void {
  if (!notify) return;
  try {
    notify(sessionId, executionId);
  } catch (error) {
    console.warn("Session execution user message persistence notification failed", error);
  }
}

export function preserveProviderTurnOutcomeDuringCleanup<T>(
  providerPromise: Promise<T>,
  cleanup: (() => Promise<void>) | null,
): Promise<T> {
  return providerPromise.finally(async () => {
    if (!cleanup) {
      return;
    }
    try {
      await cleanup();
    } catch (error) {
      console.warn("Session attachment snapshot cleanup failed", error);
    }
  });
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
  input: Parameters<NonNullable<SessionRuntimeServiceDeps["appraiseCompletedTurn"]>>[0],
): void {
  if (!appraise) {
    return;
  }

  try {
    void Promise.resolve(appraise(input))
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
  input: Parameters<NonNullable<SessionRuntimeServiceDeps["appraiseCompletedTurn"]>>[0],
  retryMs: number,
): void {
  setTimeout(() => {
    void Promise.resolve().then(async () => {
      if (markReady) {
        const ready = await markCompletedTurnAppraisalReadyWithRetry(
          markReady,
          input.correlationId,
          retryMs,
        );
        if (!ready) {
          return;
        }
      }
      appraiseCompletedTurnBestEffort(appraise, input);
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
    return `${providerLabel}の使用上限に達しました。\n再実行可能時刻: ${retryAt}`;
  }

  const preview = toAuditTextPreview(message) ?? message;
  return `${providerLabel}の使用上限に達しました。\n詳細: ${preview}`;
}

function formatProviderFailureMessage(params: {
  providerId: Session["provider"];
  reason: ProviderTurnError["reason"] | null;
  message: string;
  canceled: boolean;
}): string {
  if (params.canceled) {
    return "ユーザーがキャンセルしたよ。";
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
    return "実行をキャンセルしたよ。";
  }

  if (params.reason === "usage_limit") {
    return formatProviderUsageLimitMessage(params.providerId, params.message);
  }

  return `実行に失敗したよ。\n${params.message}`;
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

function hasMeaningfulLiveRunAuditState(state: LiveSessionRunState): boolean {
  return state.threadId.trim().length > 0
    || state.assistantText.trim().length > 0
    || state.steps.length > 0
    || state.backgroundTasks.length > 0
    || state.usage !== null
    || state.errorMessage.trim().length > 0
    || state.approvalRequest !== null
    || state.elicitationRequest !== null;
}

function buildRunningAuditProgressSignature(entry: CreateAuditLogInput): string {
  return JSON.stringify({
    threadId: entry.threadId,
    assistantText: entry.assistantText,
    operations: entry.operations,
    usage: entry.usage,
    errorMessage: entry.errorMessage,
    providerMetadata: entry.providerMetadata,
  });
}

function buildRunningAuditEntry(params: {
  sessionId: string;
  createdAt: string;
  session: Pick<Session, "provider" | "model" | "reasoningEffort" | "approvalMode" | "codexSandboxMode" | "threadId" | "messages">;
  logicalPrompt: CreateAuditLogInput["logicalPrompt"];
  threadId?: string;
  clientRequestId?: string | null;
  executionId?: string | null;
  submitSource?: RunSessionTurnRequest["submitSource"];
}): CreateAuditLogInput {
  return {
    sessionId: params.sessionId,
    createdAt: params.createdAt,
    phase: "running",
    provider: params.session.provider,
    model: params.session.model,
    reasoningEffort: params.session.reasoningEffort,
    approvalMode: params.session.approvalMode,
    sandboxMode: params.session.codexSandboxMode,
    userMessageSeq: Math.max(0, params.session.messages.length - 1),
    threadId: params.threadId ?? params.session.threadId,
    logicalPrompt: params.logicalPrompt,
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    providerMetadata: params.clientRequestId || params.executionId
      ? [{
          provider: params.session.provider,
          kind: "session_turn_request",
          source: "session-runtime-service.run-session-turn",
          summary: "Session turn request correlation",
          payload: {
            ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
            ...(params.executionId ? { executionId: params.executionId } : {}),
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
  session: Pick<Session, "provider" | "model" | "reasoningEffort" | "approvalMode">;
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
    model: params.session.model,
    reasoningEffort: params.session.reasoningEffort,
    approvalMode: params.session.approvalMode,
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
  private readonly pendingSessionRunCancels = new Set<string>();
  private readonly sessionRunControllers = new Map<string, AbortController>();

  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  private upsertTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Awaitable<Session> {
    return this.deps.upsertTerminalSession?.(session, terminalCommit) ?? this.deps.upsertSession(session);
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

  private trackTerminatingSessionRun(sessionId: string, promise: Promise<unknown>): void {
    const trackedPromises = this.terminatingSessionRuns.get(sessionId) ?? new Set<Promise<unknown>>();
    if (trackedPromises.has(promise)) {
      return;
    }
    trackedPromises.add(promise);
    this.terminatingSessionRuns.set(sessionId, trackedPromises);
    const release = () => {
      trackedPromises.delete(promise);
      if (trackedPromises.size === 0) {
        this.terminatingSessionRuns.delete(sessionId);
      }
      if (
        !this.startingSessionRuns.has(sessionId)
        && !this.inFlightSessionRuns.has(sessionId)
        && !this.terminatingSessionRuns.has(sessionId)
      ) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
        try {
          void Promise.resolve(this.deps.onSessionRunAvailable?.(sessionId)).catch((error) => {
            console.warn("Session run availability callback failed", error);
          });
        } catch (error) {
          console.warn("Session run availability callback failed", error);
        }
      }
    };
    promise.then(release, release);
  }

  private resolvePendingInteractionsBestEffort(sessionId: string): void {
    try {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
    } catch (error) {
      console.warn("Pending approval cleanup failed", error);
    }
    try {
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
    } catch (error) {
      console.warn("Pending elicitation cleanup failed", error);
    }
  }

  reset(): void {
    for (const sessionId of new Set([...this.startingSessionRuns, ...this.inFlightSessionRuns])) {
      this.sessionRunControllers.get(sessionId)?.abort();
      this.pendingSessionRunCancels.add(sessionId);
      this.resolvePendingInteractionsBestEffort(sessionId);
    }
    this.startingSessionRuns.clear();
    this.inFlightSessionRuns.clear();
    this.sessionRunControllers.clear();
  }

  cancelRun(sessionId: string): void {
    const controller = this.sessionRunControllers.get(sessionId);
    if (!controller) {
      if (this.startingSessionRuns.has(sessionId)) {
        this.pendingSessionRunCancels.add(sessionId);
      }
      this.resolvePendingInteractionsBestEffort(sessionId);
      return;
    }

    controller.abort();
    this.resolvePendingInteractionsBestEffort(sessionId);
  }

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
    return (await this.runSessionTurnWithCatalog(sessionId, request, null)).session;
  }

  async runExternalSessionTurn(
    sessionId: string,
    catalogRevision: number,
    request: RunSessionTurnRequest,
    executionId?: string,
  ): Promise<ExternalSessionTurnResult> {
    return this.runSessionTurnWithCatalog(sessionId, request, catalogRevision, executionId);
  }

  async runQueuedGuiSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest,
    executionId: string,
  ): Promise<ExternalSessionTurnResult> {
    return this.runSessionTurnWithCatalog(sessionId, request, null, executionId);
  }

  private async runSessionTurnWithCatalog(
    sessionId: string,
    request: RunSessionTurnRequest,
    externalCatalogRevision: number | null,
    externalExecutionId?: string,
  ): Promise<ExternalSessionTurnResult> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const alreadyInFlight = this.isRunInFlight(sessionId);
    logSessionRunStuckInvestigation("runtime.requested", {
      sessionId,
      clientRequestId,
      submitSource,
      isRunInFlight: alreadyInFlight,
    });
    if (alreadyInFlight) {
      logSessionRunStuckInvestigation("runtime.rejected", {
        sessionId,
        clientRequestId,
        reason: "session-run-in-flight",
      });
      throw new Error("このセッションはまだ実行中だよ。");
    }
    this.startingSessionRuns.add(sessionId);
    const runAbortController = new AbortController();
    this.sessionRunControllers.set(sessionId, runAbortController);
    if (this.pendingSessionRunCancels.delete(sessionId)) {
      runAbortController.abort();
    }
    const setupPromise = this.runSessionTurnInternal(
      sessionId,
      request,
      runAbortController,
      externalCatalogRevision,
      externalExecutionId,
    );
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
    }
  }

  async validateSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<void> {
    const session = await this.deps.getSession(sessionId);
    if (!session) {
      throw new SessionTurnValidationError("SESSION_NOT_FOUND", "対象セッションが見つからないよ。");
    }
    await this.validateWorkspace(session.workspacePath);
    if (isReadOnlySession(session)) {
      throw new SessionTurnValidationError(
        "SESSION_READ_ONLY",
        "閲覧専用セッションには送信できないよ。新しいセッションを作成してください。",
      );
    }
    if (!request.userMessage.trim()) {
      throw new SessionTurnValidationError("INVALID_INPUT", "送信するメッセージが空だよ。");
    }

    const requestedSession = applyTurnRuntimeOptions(session, request);
    const providerSession = this.deps.resolveProviderSession?.(requestedSession) ?? requestedSession;
    const composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    if (composerPreview.errors.length > 0) {
      throw new SessionTurnValidationError(
        "INVALID_INPUT",
        composerPreview.errors[0] ?? "添付の解決に失敗したよ。",
      );
    }

    const appSettings = this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new SessionTurnValidationError("PROVIDER_DISABLED", "この provider は Settings で無効になっているよ。");
    }
    try {
      const { provider } = this.deps.resolveProviderCatalog(session.provider, session.catalogRevision);
      this.deps.getProviderCodingAdapter(provider.id);
    } catch {
      throw new SessionTurnValidationError("PROVIDER_UNAVAILABLE", "この provider は現在利用できないよ。");
    }
  }

  async validateExternalSessionTurn(
    sessionId: string,
    catalogRevision: number,
    request: RunSessionTurnRequest,
    requestedProviderId?: string,
  ): Promise<RunSessionTurnRequest> {
    const session = await this.deps.getSession(sessionId);
    if (!session) {
      throw new SessionTurnValidationError("SESSION_NOT_FOUND", "対象セッションが見つからないよ。");
    }
    await this.validateWorkspace(session.workspacePath);
    if (session.sessionKind !== "default") {
      throw new SessionTurnValidationError(
        "SESSION_KIND_UNSUPPORTED",
        "このSession種別は外部Turnに対応していないよ。",
      );
    }
    if (isReadOnlySession(session)) {
      throw new SessionTurnValidationError(
        "SESSION_READ_ONLY",
        "閲覧専用セッションには送信できないよ。新しいセッションを作成してください。",
      );
    }
    if (!request.userMessage.trim()) {
      throw new SessionTurnValidationError("INVALID_INPUT", "送信するメッセージが空だよ。");
    }
    if (requestedProviderId !== undefined && requestedProviderId !== session.provider) {
      throw new SessionTurnValidationError("INVALID_INPUT", "Turn provider does not match the target Session provider.");
    }

    let currentCatalog: ReturnType<SessionRuntimeServiceDeps["resolveProviderCatalog"]>;
    try {
      currentCatalog = this.deps.resolveProviderCatalog(session.provider, null);
    } catch {
      throw new SessionTurnValidationError("PROVIDER_UNAVAILABLE", "この provider は現在利用できないよ。");
    }
    const { snapshot, provider } = currentCatalog;
    if (snapshot.revision !== catalogRevision) {
      throw new SessionTurnValidationError(
        "CATALOG_REVISION_STALE",
        "The model catalog revision is stale.",
      );
    }
    if (!request.model?.trim() || !request.reasoningEffort) {
      throw new SessionTurnValidationError("INVALID_INPUT", "modelとreasoningEffortを指定してね。");
    }
    try {
      resolveModelSelection(provider, request.model, request.reasoningEffort);
    } catch {
      throw new SessionTurnValidationError(
        "INVALID_INPUT",
        "指定されたmodelとreasoningEffortの組み合わせは利用できないよ。",
      );
    }

    if (session.provider === "codex") {
      if (!request.codexSandboxMode || request.customAgentName !== undefined) {
        throw new SessionTurnValidationError("INVALID_INPUT", "Codex Turn requires codexSandboxMode only.");
      }
    } else if (session.provider === "copilot") {
      if (request.customAgentName === undefined || request.codexSandboxMode !== undefined) {
        throw new SessionTurnValidationError("INVALID_INPUT", "Copilot Turn requires customAgentName only.");
      }
      if (
        request.customAgentName
        && !await this.deps.isSessionCustomAgentAvailable?.(session.workspacePath, request.customAgentName)
      ) {
        throw new SessionTurnValidationError("INVALID_INPUT", "指定されたcustom agentは利用できないよ。");
      }
    } else {
      throw new SessionTurnValidationError("PROVIDER_UNAVAILABLE", "この provider は現在利用できないよ。");
    }

    const requestedSession = applyTurnRuntimeOptions(session, request);
    const providerSession = this.deps.resolveProviderSession?.(requestedSession) ?? requestedSession;
    const composerPreview = await this.resolveExternalAttachments(providerSession, request);
    if (composerPreview.errors.length > 0) {
      throw new SessionTurnValidationError(
        "PATH_OUTSIDE_SESSION_FOLDER",
        composerPreview.errors[0] ?? "添付の解決に失敗したよ。",
      );
    }

    const appSettings = this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new SessionTurnValidationError("PROVIDER_DISABLED", "この provider は Settings で無効になっているよ。");
    }
    try {
      this.deps.getProviderCodingAdapter(provider.id);
    } catch {
      throw new SessionTurnValidationError("PROVIDER_UNAVAILABLE", "この provider は現在利用できないよ。");
    }
    return request;
  }

  private async runSessionTurnInternal(
    sessionId: string,
    request: RunSessionTurnRequest,
    runAbortController: AbortController,
    externalCatalogRevision: number | null,
    externalExecutionId?: string,
  ): Promise<ExternalSessionTurnResult> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const observedAt = (this.deps.currentDate ?? (() => new Date()))();
    const investigationStartedAt = Date.now();
    const storedSession = await this.deps.getSession(sessionId);
    throwIfRunCanceled(runAbortController.signal);
    if (!storedSession) {
      throw new Error("対象セッションが見つからないよ。");
    }
    if (externalCatalogRevision !== null && storedSession.sessionKind !== "default") {
      throw new SessionTurnValidationError(
        "SESSION_KIND_UNSUPPORTED",
        "このSession種別は外部Turnに対応していないよ。",
      );
    }
    const resolvedSession = await Promise.resolve(
      this.deps.resolveRuntimeSessionForTurn?.(storedSession) ?? storedSession,
    );
    await this.validateWorkspace(resolvedSession.workspacePath);
    const shouldResetCharacterAuthoringThread = storedSession.sessionKind === "character-authoring"
      && storedSession.characterRuntimeSnapshot !== null
      && resolvedSession.characterRuntimeSnapshot === null;
    let session = shouldResetCharacterAuthoringThread
      ? { ...resolvedSession, threadId: "" }
      : resolvedSession;
    if (shouldResetCharacterAuthoringThread) {
      session = await this.deps.upsertSession(session);
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
      throw new Error("このセッションはまだ実行中だよ。");
    }

    if (isReadOnlySession(session)) {
      throw new Error("閲覧専用セッションには送信できないよ。新しいセッションを作成してください。");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("送信するメッセージが空だよ。");
    }

    const turnSession = applyTurnRuntimeOptions(session, request);
    const providerSession = this.deps.resolveProviderSession?.(turnSession) ?? turnSession;
    if (
      externalCatalogRevision !== null
      && request.attachments?.some((attachment) => attachment.identity === undefined)
    ) {
      throw new SessionTurnValidationError("PATH_OUTSIDE_SESSION_FOLDER", "SessionFolder attachment admission identity is missing.");
    }
    const composerPreview = externalCatalogRevision === null
      ? await this.deps.resolveComposerPreview(providerSession, request.userMessage, "workspace")
      : await this.resolveExternalAttachments(providerSession, request);
    throwIfRunCanceled(runAbortController.signal);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "Failed to resolve attachment.");
    }

    const appSettings = this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new Error("この provider は Settings で無効になっているよ。");
    }

    const { snapshot, provider } = this.deps.resolveProviderCatalog(
      session.provider,
      externalCatalogRevision ?? session.catalogRevision,
    );
    if (externalCatalogRevision !== null) {
      if (snapshot.revision !== externalCatalogRevision) {
        throw new SessionTurnValidationError("CATALOG_REVISION_STALE", "The model catalog revision is stale.");
      }
      if (!request.model?.trim() || !request.reasoningEffort) {
        throw new SessionTurnValidationError("INVALID_INPUT", "modelとreasoningEffortを指定してね。");
      }
      try {
        resolveModelSelection(provider, request.model, request.reasoningEffort);
      } catch {
        throw new SessionTurnValidationError(
          "INVALID_INPUT",
          "指定されたmodelとreasoningEffortの組み合わせは利用できないよ。",
        );
      }
    }
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    const includeSessionRoleContext = this.deps.includeNormalSessionRoleContext
      && session.sessionKind === "default";
    if (includeSessionRoleContext && !session.roleBinding) {
      throw new SessionTurnValidationError(
        "SESSION_ROLE_BINDING_INVALID",
        "The Session Role binding is unavailable.",
      );
    }
    let agentRuntimeBinding = await Promise.resolve(
      this.deps.getProviderAgentRuntimeBinding?.({ session, provider }) ?? null,
    );
    const sessionMemory = this.deps.getSessionMemory(session);
    const projectMemoryEntries = this.deps.resolveProjectMemoryEntriesForPrompt(session, nextMessage, sessionMemory);
    const sessionCharacter = await this.deps.resolveSessionCharacter?.(session) ?? null;
    const conversationTimingContext = await Promise.resolve(
      this.deps.resolveConversationTimingContext?.(session, observedAt) ?? null,
    );
    const characterContext = await Promise.resolve(
      this.deps.resolveCharacterContext?.(session, nextMessage) ?? null,
    );
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
        sessionFolderPath: this.deps.resolveSessionFolderPath?.(providerSession.id),
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
        sessionRoleBinding: includeSessionRoleContext ? session.roleBinding : null,
      });

      runningSession = {
        ...session,
        updatedAt: currentTimestampLabel(),
        status: "running",
        runState: "running",
        messages: [...session.messages, { role: "user", text: nextMessage }],
      };

      const runningUpsertStartedAt = Date.now();
      await this.deps.upsertSession(runningSession);
      if (externalExecutionId) {
        notifyExecutionUserMessagePersistedBestEffort(
          this.deps.notifyExecutionUserMessagePersisted,
          sessionId,
          externalExecutionId,
        );
      }
      logSessionRunStuckInvestigation("runtime.running-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - runningUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: runningSession.messages.length,
      });
      setupRunningSessionSaved = true;
      throwIfRunCanceled(runAbortController.signal);
      this.inFlightSessionRuns.add(sessionId);
      initialLiveState = {
        ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
        backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
        reasoningText: "",
      };
      this.deps.setLiveSessionRun(sessionId, initialLiveState);
      setupLiveRun = true;

      const runtimeOptionSession = applyTurnRuntimeOptions(runningSession, request);
      runningAuditEntry = buildRunningAuditEntry({
        sessionId,
        createdAt: new Date().toISOString(),
        session: runtimeOptionSession,
        logicalPrompt: promptForAudit.logicalPrompt,
        clientRequestId,
        executionId: externalExecutionId,
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
      this.resolvePendingInteractionsBestEffort(sessionId);
      this.inFlightSessionRuns.delete(sessionId);
      this.sessionRunControllers.delete(sessionId);
      if (setupLiveRun) {
        this.deps.setLiveSessionRun(sessionId, null);
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
    let runningAuditProgressSignature = buildRunningAuditProgressSignature(latestObservedRunningAuditEntry);
    let terminalAuditSettled = false;
    let liveProgressGeneration = 0;
    let auditWriteQueue: Promise<void> = Promise.resolve();
    let auditWriteError: unknown = null;
    let auditWritesDetached = false;

    let activeRunningSession = runningSession;
    let externalTurnContextPersisted = false;
    const enqueueAuditWrite = (
      nextRunningAuditEntry: CreateAuditLogInput,
      nextSignature: string,
    ): Promise<void> => {
      latestObservedRunningAuditEntry = nextRunningAuditEntry;
      runningAuditProgressSignature = nextSignature;
      auditWriteQueue = auditWriteQueue
        .then(async () => {
          await this.deps.updateAuditLog(runningAuditLog.id, nextRunningAuditEntry);
          runningAuditEntry = nextRunningAuditEntry;
        })
        .catch((error) => {
          auditWriteError = auditWriteError ?? error;
        });
      return auditWriteQueue;
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
    const syncRunningAuditFromLiveState = async (nextLiveState: LiveSessionRunState) => {
      if (terminalAuditSettled) {
        return;
      }
      this.deps.setLiveSessionRun(sessionId, nextLiveState);
      if (!hasMeaningfulLiveRunAuditState(nextLiveState)) {
        return;
      }

      const runtimeAuditSession = applyTurnRuntimeOptions(activeRunningSession, request);
      const nextRunningAuditEntry: CreateAuditLogInput = {
        ...latestObservedRunningAuditEntry,
        phase: "running",
        provider: runtimeAuditSession.provider,
        model: runtimeAuditSession.model,
        reasoningEffort: runtimeAuditSession.reasoningEffort,
        approvalMode: runtimeAuditSession.approvalMode,
        threadId: pickPreferredThreadId(
          nextLiveState.threadId,
          latestObservedRunningAuditEntry.threadId,
          runtimeAuditSession.threadId,
        ),
        assistantText: nextLiveState.assistantText.trim()
          ? toAuditTextPreview(nextLiveState.assistantText) ?? ""
          : latestObservedRunningAuditEntry.assistantText,
        operations: (() => {
          const operations = buildLiveRunAuditOperations(nextLiveState);
          return operations.length > 0 ? operations : latestObservedRunningAuditEntry.operations;
        })(),
        usage: nextLiveState.usage ?? latestObservedRunningAuditEntry.usage,
        errorMessage: nextLiveState.errorMessage.trim()
          ? toAuditTextPreview(nextLiveState.errorMessage) ?? ""
          : latestObservedRunningAuditEntry.errorMessage,
      };
      const nextSignature = buildRunningAuditProgressSignature(nextRunningAuditEntry);
      if (nextSignature === runningAuditProgressSignature) {
        return;
      }

      await enqueueAuditWrite(nextRunningAuditEntry, nextSignature);
    };
    await syncRunningAuditFromLiveState(initialLiveState);
    const runProviderTurn = async (turnSession: Session) => {
      const progressGeneration = ++liveProgressGeneration;
      const runtimeOptionSession = applyTurnRuntimeOptions(turnSession, request);
      const effectiveTurnSession = this.deps.resolveProviderSession?.(runtimeOptionSession) ?? runtimeOptionSession;
      if (!externalTurnContextPersisted && externalExecutionId && this.deps.persistExternalTurnContext) {
        const effectiveOptions: PublicTranscriptTurnOptionsV1 = {
          provider: effectiveTurnSession.provider === "copilot" ? "copilot" : "codex",
          model: effectiveTurnSession.model,
          reasoningEffort: effectiveTurnSession.reasoningEffort,
          approvalMode: effectiveTurnSession.approvalMode,
          sandboxMode: effectiveTurnSession.provider === "codex" ? effectiveTurnSession.codexSandboxMode : null,
          customAgentName: effectiveTurnSession.provider === "copilot" ? effectiveTurnSession.customAgentName ?? null : null,
        };
        await this.deps.persistExternalTurnContext({
          turnId: runningAuditLog.id,
          sessionId,
          executionId: externalExecutionId,
          effectiveOptions,
          attachments: (request.attachments ?? []).map((attachment) => ({
            kind: attachment.kind,
            relativePath: attachment.relativePath,
          })),
          createdAt: runningAuditLog.createdAt,
          updatedAt: runningAuditLog.createdAt,
        });
        externalTurnContextPersisted = true;
      }
      const dispatchPreview = externalCatalogRevision === null
        ? composerPreview
        : await this.resolveExternalAttachments(effectiveTurnSession, request);
      if (dispatchPreview.errors.length > 0) {
        throw new SessionTurnValidationError(
          "PATH_OUTSIDE_SESSION_FOLDER",
          dispatchPreview.errors[0] ?? "添付の解決に失敗したよ。",
        );
      }
      const requiresAttachmentSnapshot = externalCatalogRevision !== null && dispatchPreview.attachments.length > 0;
      const snapshotNamespacePath = this.deps.attachmentSnapshotNamespacePath;
      if (requiresAttachmentSnapshot && !snapshotNamespacePath) {
        throw new Error("Session attachment snapshot namespace is unavailable.");
      }
      let attachmentSnapshot: Awaited<ReturnType<typeof createSessionAttachmentSnapshot>> | null = null;
      if (requiresAttachmentSnapshot && snapshotNamespacePath) {
        try {
          attachmentSnapshot = await createSessionAttachmentSnapshot(
            dispatchPreview.attachments,
            request.attachments ?? [],
            { snapshotNamespacePath },
          );
        } catch (error) {
          if (error instanceof SessionAttachmentSnapshotLimitError) {
            throw new SessionTurnValidationError(error.code, error.message);
          }
          throw error;
        }
      }
      const providerTurnPromise = Promise.resolve().then(() => providerAdapter.runSessionTurn({
        session: effectiveTurnSession,
        sessionFolderPath: this.deps.resolveSessionFolderPath?.(effectiveTurnSession.id),
        sessionMemory,
        projectMemoryEntries,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: attachmentSnapshot?.attachments ?? dispatchPreview.attachments,
        conversationTimingContext: conversationTimingContext ?? undefined,
        characterContext: characterContext ?? undefined,
        agentRuntimeBinding,
        signal: runAbortController.signal,
        onApprovalRequest: (approvalRequest) => {
          const decision = externalExecutionId && this.deps.registerExternalApprovalInteraction
            ? this.deps.registerExternalApprovalInteraction({
              sessionId,
              executionId: externalExecutionId,
              request: approvalRequest,
              signal: runAbortController.signal,
            })
            : this.deps.waitForApprovalDecision(sessionId, approvalRequest, runAbortController.signal);
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
        onElicitationRequest: (elicitationRequest) => {
          const response = externalExecutionId && this.deps.registerExternalElicitationInteraction
            ? this.deps.registerExternalElicitationInteraction({
              sessionId,
              executionId: externalExecutionId,
              request: elicitationRequest,
              signal: runAbortController.signal,
            })
            : this.deps.waitForElicitationResponse(sessionId, elicitationRequest, runAbortController.signal);
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
      }, (state) => {
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
        if (externalExecutionId) {
          this.deps.publishExternalProgress?.({
            executionId: externalExecutionId,
            assistantText: nextLiveState.assistantText,
            updatedAt: this.deps.currentTimestampLabel?.() ?? new Date().toISOString(),
          });
        }
        void syncRunningAuditFromLiveState(nextLiveState).catch((error) => {
          console.warn("Audit progress update failed", error);
        });
      }));
      const providerPromise = preserveProviderTurnOutcomeDuringCleanup(
        providerTurnPromise,
        attachmentSnapshot ? () => attachmentSnapshot.dispose() : null,
      );
      return waitForProviderTurnWithCancelDeadline(
        providerPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () => buildCanceledPartialResult(this.deps.getLiveSessionRun(sessionId), promptForAudit),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
      );
    };

    try {
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
            !didInternalRetry &&
            !isCanceledRunError(error) &&
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
          this.deps.setLiveSessionRun(sessionId, {
            ...buildEmptyLiveSessionRunState(sessionId, ""),
            backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
          });
          const resetAuditEntry = buildRunningAuditEntry({
            sessionId,
            createdAt: runningAuditLog.createdAt,
            session: applyTurnRuntimeOptions(activeRunningSession, request),
            logicalPrompt: promptForAudit.logicalPrompt,
            threadId: "",
            clientRequestId,
            submitSource: submitSource ?? undefined,
          });
          const resetAuditSignature = buildRunningAuditProgressSignature(resetAuditEntry);
          await flushAuditWrites();
          runningAuditEntry = resetAuditEntry;
          latestObservedRunningAuditEntry = resetAuditEntry;
          runningAuditProgressSignature = resetAuditSignature;
          await this.deps.updateAuditLog(runningAuditLog.id, runningAuditEntry);
        }
      }
      if (!result) {
        throw new Error("provider turn result を確定できなかったよ。");
      }

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
        notifySessionTurnCompletedBestEffort(
          this.deps.notifySessionTurnCompleted,
          storedCompletedSession,
          result.lastNonEmptyAssistantMessageText ?? "",
        );
      }
      completeCompletedTurnAppraisalBestEffort(
        requiresDurableAppraisal ? this.deps.markCompletedTurnAppraisalReady : undefined,
        this.deps.appraiseCompletedTurn,
        {
          session: storedCompletedSession,
          correlationId: affectTurnCorrelationId,
          userMessage: nextMessage,
          assistantMessage: result.assistantText,
          assistantMessageIndex,
          occurredAt: completedAt,
        },
        this.deps.appraisalReadyRetryMs ?? DEFAULT_APPRAISAL_READY_RETRY_MS,
      );

      const completeCompletedAudit = async (): Promise<void> => {
        const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
        const logicalPromptEstimate = estimateLogicalPromptTokens(result.logicalPrompt);
        const completedAuditEntry = buildTerminalAuditEntry({
          baseEntry: latestObservedRunningAuditEntry,
          phase: "completed",
          completedAt,
          session: applyTurnRuntimeOptions(storedCompletedSession, request),
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
        const completedAuditUpdateStartedAt = Date.now();
        try {
          if (!auditWritesDrained) {
            void auditWriteQueue
              .then(() => this.deps.updateAuditLog(runningAuditLog.id, completedAuditEntry))
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
      return { session: storedCompletedSession, terminalState: "completed" };
    } catch (error: unknown) {
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
      const message = error instanceof Error ? error.message : String(error);
      const providerErrorReason = providerTurnError?.reason ?? null;
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
      const shouldResetFailedThread = shouldResetFailedSessionThread(
        error,
        activeRunningSession.threadId,
        partialResult,
        canceled,
      );
      const nextSessionThreadId = shouldResetFailedThread ? "" : failedAuditThreadId;
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
          session: applyTurnRuntimeOptions(storedFailedSession, request),
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
            .then(() => this.deps.updateAuditLog(runningAuditLog.id, failedAuditEntry))
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
      invalidateProviderSessionThreadBestEffort(
        this.deps.invalidateProviderSessionThread,
        storedFailedSession.provider,
        sessionId,
      );
      runInBackgroundMacrotask("Detached terminal audit processing failed", completeFailedAudit);
      return {
        session: storedFailedSession,
        terminalState: canceled ? "canceled" : "failed",
      };
    } finally {
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      }
      this.resolvePendingInteractionsBestEffort(sessionId);
      this.inFlightSessionRuns.delete(sessionId);
      const currentLiveState = this.deps.getLiveSessionRun(sessionId);
      const preservedBackgroundTasks = currentLiveState?.backgroundTasks ?? [];
      const preservedReasoningText = currentLiveState?.reasoningText ?? "";
      if (preservedBackgroundTasks.length > 0 || preservedReasoningText.trim().length > 0) {
        this.deps.setLiveSessionRun(sessionId, {
          ...buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId),
          backgroundTasks: preservedBackgroundTasks,
          reasoningText: preservedReasoningText,
        });
      } else {
        this.deps.setLiveSessionRun(sessionId, null);
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

  private resolveExternalAttachments(
    session: Session,
    request: RunSessionTurnRequest,
  ): Promise<ComposerPreview> {
    if ((request.attachments?.length ?? 0) === 0) {
      return Promise.resolve({ attachments: [], errors: [] });
    }
    if (!this.deps.resolveSessionFolderAttachments) {
      throw new SessionTurnValidationError("RUNTIME_UNAVAILABLE", "SessionFolder attachments are unavailable.");
    }
    return this.deps.resolveSessionFolderAttachments(session, request.attachments ?? []);
  }

  private async validateWorkspace(workspacePath: string): Promise<void> {
    if (!this.deps.validateWorkspaceDirectory) {
      return;
    }
    const result = await this.deps.validateWorkspaceDirectory(workspacePath);
    if (result.valid) {
      return;
    }
    const detail = resolveWorkspaceDirectoryValidationMessage(result);
    throw new SessionTurnValidationError(
      "WORKSPACE_UNAVAILABLE",
      `Workspace is unavailable. ${detail} Restore it and recheck before sending messages.`,
    );
  }

}
