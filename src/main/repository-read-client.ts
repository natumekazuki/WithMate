import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import type {
  ChildResultListItem,
  MessageListItem,
  Page,
  RecoveryProjection,
  RunDetail,
  RunEventListItem,
  RunOutputListItem,
  RunOutputPayloadMetadata,
  SessionDeletionCleanupPage,
  SessionDetail,
  SessionListItem,
} from "../shared/repository-read-model.js";

type RequestOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

/** CP2へraw operation名を露出せず、Repository read契約を型付きで提供する。 */
export class RepositoryReadClient {
  constructor(readonly worker: PersistenceWorkerClient) {}

  sessionsPage(
    input: Readonly<{ workspaceKey: string; lifecycleStatus?: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<Page<SessionListItem>> {
    return this.worker.request("repository.sessions.page", "read", input, options);
  }

  sessionGet(
    input: Readonly<{ sessionId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<
    Readonly<{
      session: SessionDetail;
      execution: Readonly<{
        state: string;
        activeRunId?: string;
        latestRunId?: string;
      }>;
    }>
  > {
    return this.worker.request("repository.session.get", "read", input, options);
  }

  sessionDirectoriesChunk(
    input: Readonly<{ sessionId: string; workspaceKey: string; offset: number; maxBytes: number }>,
    options?: RequestOptions,
  ): Promise<Readonly<{ sessionId: string; offset: number; totalBytes: number; eof: boolean; bytes: ArrayBuffer }>> {
    return this.worker.request("repository.session.directories-chunk", "read", input, options);
  }

  messagesPage(
    input: Readonly<{ sessionId: string; workspaceKey: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<Page<MessageListItem> & Readonly<{ sessionId: string; workspaceKey: string }>> {
    return this.worker.request("repository.messages.page", "read", input, options);
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
    return this.worker.request("repository.message.content-chunk", "read", input, options);
  }

  runEventsPage(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<Page<RunEventListItem> & Readonly<{ sessionId: string; runId: string; workspaceKey: string }>> {
    return this.worker.request("repository.run.events.page", "read", input, options);
  }

  runGet(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<Readonly<{ sessionId: string; workspaceKey: string; run: RunDetail }>> {
    return this.worker.request("repository.run.get", "read", input, options);
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
    return this.worker.request("repository.run.snapshot-chunk", "read", input, options);
  }

  runOutputsPage(
    input: Readonly<{
      sessionId: string;
      runId: string;
      workspaceKey: string;
      category?: string;
      cursor?: string;
      limit?: number;
    }>,
    options?: RequestOptions,
  ): Promise<Page<RunOutputListItem> & Readonly<{ sessionId: string; runId: string; workspaceKey: string }>> {
    return this.worker.request("repository.run.outputs.page", "read", input, options);
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
    return this.worker.request("repository.run.outputs.counts", "read", input, options);
  }

  runOutputPayloadMetadata(
    input: Readonly<{ sessionId: string; runId: string; outputItemId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<RunOutputPayloadMetadata> {
    return this.worker.request("repository.run.output.payload-metadata", "read", input, options);
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
    return this.worker.request("payload.read_chunk", "read", input, options);
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
    return this.worker.request("repository.child-results.page", "read", input, options);
  }

  sessionDeletionCleanupPage(
    input: Readonly<{ cleanupToken: string; workspaceKey: string; cursor?: string; limit?: number }>,
    options?: RequestOptions,
  ): Promise<SessionDeletionCleanupPage> {
    return this.worker.request("repository.session-deletion.cleanup.page", "read", input, options);
  }

  recoveryGet(
    input: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
    options?: RequestOptions,
  ): Promise<RecoveryProjection> {
    return this.worker.request("repository.recovery.get", "read", input, options);
  }
}
