import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";
import type { RepositoryReadClient } from "../../../src/main/repository-read-client.js";
import type { RepositoryWriteClient } from "../../../src/main/repository-write-client.js";

declare const reads: RepositoryReadClient;
declare const writes: RepositoryWriteClient;
declare const worker: PersistenceWorkerClient;

void reads.sessionGet({ sessionId: "session-1" });
void writes.createSession({
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  session: {
    id: "session-1",
    providerId: "codex",
    workspaceKey: "unvalidated-workspace",
    workspacePath: "C:\\workspace",
    allowedAdditionalDirectories: [],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 1,
  },
});
void worker.request("repository.session.create", "write", {});
