export const REPOSITORY_READ_OPERATIONS = {
  sessionsPage: "repository.sessions.page",
  sessionGet: "repository.session.get",
  sessionDirectoriesChunk: "repository.session.directories-chunk",
  messagesPage: "repository.messages.page",
  messageContentChunk: "repository.message.content-chunk",
  runEventsPage: "repository.run.events.page",
  runGet: "repository.run.get",
  runSnapshotChunk: "repository.run.snapshot-chunk",
  runOutputsPage: "repository.run.outputs.page",
  runOutputCounts: "repository.run.outputs.counts",
  runOutputPayloadMetadata: "repository.run.output.payload-metadata",
  payloadChunk: "payload.read_chunk",
  childResultsPage: "repository.child-results.page",
  sessionDeletionCleanupPage: "repository.session-deletion.cleanup.page",
  recoveryGet: "repository.recovery.get",
} as const;

export const REPOSITORY_READ_LIMITS = {
  sessions: { default: 25, max: 100 },
  messages: { default: 50, max: 100 },
  events: { default: 100, max: 200 },
  outputs: { default: 100, max: 200 },
  childResults: { default: 100, max: 200 },
  sessionDeletionItems: { default: 100, max: 200 },
} as const;

export type PageOmission = Readonly<{
  omitted: true;
  reason: "response_size_limit";
  ordinal?: number;
}>;

export type Page<T> = Readonly<{ items: readonly (T | PageOmission)[]; nextCursor?: string }>;

export type SessionExecutionState = "not_started" | "running" | "completed" | "failed" | "canceled" | "interrupted";

export type SessionListItem = Readonly<{
  id: string;
  workspaceKey: string;
  defaultCharacterId: string;
  lifecycleStatus: "active" | "archived" | "closed";
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  executionState: SessionExecutionState;
  activeRunId?: string;
  latestRunId?: string;
  stateChangedAt: number;
}>;

export type SessionDetail = Readonly<{
  id: string;
  workspaceKey: string;
  allowedAdditionalDirectoriesByteLength: number;
  allowedAdditionalDirectoriesState: "inline" | "chunked";
  allowedAdditionalDirectories?: readonly string[];
  defaultCharacterId: string;
  maxConcurrentChildRuns: number;
  lifecycleStatus: "active" | "archived" | "closed";
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}>;

export type RunDetail = Readonly<{
  id: string;
  sessionId: string;
  ordinal: number;
  initiatingMessageId: string;
  finalAssistantMessageId?: string;
  retryOfRunId?: string;
  phase: string;
  executionSnapshotByteLength: number;
  executionSnapshotState: "inline" | "chunked";
  executionSnapshot?: unknown;
  failureOrigin?: string;
  providerErrorCode?: string;
  errorSummary?: string;
  cancelRequestedAt?: number;
  cancelAcknowledgedAt?: number;
  terminalEventReceivedAt?: number;
  externalSideEffectState: string;
  createdAt: number;
  startedAt?: number;
  terminalAt?: number;
  updatedAt: number;
  version: number;
}>;

export type RunOutputPayloadMetadata = Readonly<{
  sessionId: string;
  runId: string;
  workspaceKey: string;
  outputItemId: string;
  payloadFormat: "text" | "json" | "binary";
  mediaType?: string;
  byteLength: number;
  contentSha256: string;
  createdAt: number;
}>;

export type ChildResultListItem = Readonly<{
  id: string;
  delegationId: string;
  ordinal: number;
  childRunId: string;
  availabilityState: "pending" | "available";
  terminalPhaseSnapshot?: string;
  resultSummary?: string;
  availableAt?: number;
  firstCollectedByParentRunId?: string;
  firstCollectedAt?: number;
  parentSessionId: string;
  childSessionId: string;
  orchestrationRootSessionId: string;
  workspaceKey: string;
}>;

export type SessionDeletionItem = Readonly<{
  ordinal: number;
  sessionId: string;
}>;

export type SessionDeletionCleanupPage = Page<SessionDeletionItem> &
  Readonly<{
    cleanupToken: string;
    deletedSessionCount: number;
    localOnly: true;
  }>;

export type RecoveryProjection = Readonly<{
  runId: string;
  sessionId: string;
  workspaceKey: string;
  runPhase: string;
  runUpdatedAt: number;
  attemptId: string | null;
  attemptOrdinal: number | null;
  attemptState: string | null;
  externalExecutionId: string | null;
  bindingId: string | null;
  providerId: string | null;
  persistenceMode: "persistent" | "ephemeral" | null;
  bindingState: "creating" | "active" | "invalidated" | "superseded" | null;
  externalConversationId: string | null;
  dispatchState: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted" | null;
  providerIdempotencyKey: string | null;
}>;

export type MessageListItem = Readonly<{
  id: string;
  sessionId: string;
  ordinal: number;
  role: "user" | "assistant";
  contentByteLength: number;
  contentState: "inline" | "chunked";
  contentBlocks?: unknown;
  createdAt: number;
}>;

export type RunEventListItem = Readonly<{
  id: string;
  runId: string;
  ordinal: number;
  eventCode: string;
  subjectType?: string;
  subjectId?: string;
  summary?: string;
  createdAt: number;
}>;

export type RunOutputListItem = Readonly<{
  id: string;
  runId: string;
  ordinal: number;
  category: string;
  kind: string;
  summary: string;
  completionState: "complete" | "partial";
  payloadState: string;
  payloadOriginalByteLength?: number;
  storedPayloadId?: string;
  redactionState: string;
  createdAt: number;
}>;
