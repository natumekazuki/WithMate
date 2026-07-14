import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import {
  REPOSITORY_READ_OPERATIONS,
  type ChildResultListItem,
  type MessageListItem,
  type Page,
  type RecoveryProjection,
  type RunDetail,
  type RunEventListItem,
  type RunOutputListItem,
  type RunOutputPayloadMetadata,
  type SessionDeletionCleanupPage,
  type SessionDetail,
  type SessionExecutionState,
  type SessionListItem,
} from "../shared/repository-read-model.js";
import type { RunOutputCategory, SessionLifecycleStatus } from "../shared/repository-write-model.js";

type RequestOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

/** CP2へraw operation名を露出せず、Repository read契約を型付きで提供する。 */
export class RepositoryReadClient {
  constructor(readonly worker: PersistenceWorkerClient) {}

  sessionsPage(
    input: Readonly<{
      workspaceKey: string;
      lifecycleStatus?: SessionLifecycleStatus;
      cursor?: string;
      limit?: number;
    }>,
    options?: RequestOptions,
  ): Promise<Page<SessionListItem>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.sessionsPage, "read", input, options);
  }

  sessionGet(
    input: Readonly<{ sessionId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<
    Readonly<{
      session: SessionDetail;
      execution: Readonly<{
        state: SessionExecutionState;
        activeRunId?: string;
        latestRunId?: string;
      }>;
    }>
  > {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.sessionGet, "read", input, options);
  }

  sessionDirectoriesChunk(
    input: Readonly<{ sessionId: string; workspaceKey: string; offset: number; maxBytes: number }>,
    options?: RequestOptions,
  ): Promise<Readonly<{ sessionId: string; offset: number; totalBytes: number; eof: boolean; bytes: ArrayBuffer }>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.sessionDirectoriesChunk, "read", input, options);
  }

  messagesPage(
    input: Readonly<{ sessionId: string; workspaceKey: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<Page<MessageListItem> & Readonly<{ sessionId: string; workspaceKey: string }>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.messagesPage, "read", input, options);
  }

  messageContentChunk(
    input: Readonly<{ sessionId: string; messageId: string; workspaceKey: string; offset: number; maxBytes: number }>,
    options?: RequestOptions,
  ): Promise<
    Readonly<{
      sessionId: string;
      messageId: string;
      offset: number;
      totalBytes: number;
      eof: boolean;
      bytes: ArrayBuffer;
    }>
  > {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.messageContentChunk, "read", input, options);
  }

  runEventsPage(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<Page<RunEventListItem> & Readonly<{ sessionId: string; runId: string; workspaceKey: string }>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.runEventsPage, "read", input, options);
  }

  runGet(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<Readonly<{ sessionId: string; workspaceKey: string; run: RunDetail }>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.runGet, "read", input, options);
  }

  runSnapshotChunk(
    input: Readonly<{
      sessionId: string;
      runId: string;
      workspaceKey: string;
      offset: number;
      maxBytes: number;
    }>,
    options?: RequestOptions,
  ): Promise<
    Readonly<{ sessionId: string; runId: string; offset: number; totalBytes: number; eof: boolean; bytes: ArrayBuffer }>
  > {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.runSnapshotChunk, "read", input, options);
  }

  runOutputsPage(
    input: Readonly<{
      sessionId: string;
      runId: string;
      workspaceKey: string;
      category?: RunOutputCategory;
      cursor?: string;
      limit?: number;
    }>,
    options?: RequestOptions,
  ): Promise<Page<RunOutputListItem> & Readonly<{ sessionId: string; runId: string; workspaceKey: string }>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.runOutputsPage, "read", input, options);
  }

  runOutputCounts(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<
    Readonly<{
      sessionId: string;
      runId: string;
      workspaceKey: string;
      totalCount: number;
      partialCount: number;
      byCategory: Readonly<Record<string, number>>;
    }>
  > {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.runOutputCounts, "read", input, options);
  }

  runOutputPayloadMetadata(
    input: Readonly<{ sessionId: string; runId: string; outputItemId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<RunOutputPayloadMetadata> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.runOutputPayloadMetadata, "read", input, options);
  }

  payloadChunk(
    input: Readonly<{
      sessionId: string;
      runId: string;
      outputItemId: string;
      workspaceKey: string;
      offset: number;
      maxBytes: number;
    }>,
    options?: RequestOptions,
  ): Promise<Readonly<{ offset: number; totalBytes: number; eof: boolean; bytes: ArrayBuffer }>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.payloadChunk, "read", input, options);
  }

  childResultsPage(
    input: Readonly<{
      parentSessionId: string;
      workspaceKey: string;
      delegationId: string;
      cursor?: string;
      limit?: number;
    }>,
    options?: RequestOptions,
  ): Promise<Page<ChildResultListItem>> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.childResultsPage, "read", input, options);
  }

  sessionDeletionCleanupPage(
    input: Readonly<{ cleanupToken: string; workspaceKey: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<SessionDeletionCleanupPage> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.sessionDeletionCleanupPage, "read", input, options);
  }

  recoveryGet(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<RecoveryProjection> {
    return this.worker.request(REPOSITORY_READ_OPERATIONS.recoveryGet, "read", input, options);
  }
}
