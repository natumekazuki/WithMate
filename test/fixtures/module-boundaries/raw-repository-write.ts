import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";

declare const worker: PersistenceWorkerClient;

const { RepositoryWriteClient } = await import("../../../src/main/repository-write-client.js");
const writes = new RepositoryWriteClient(worker);

void writes["createSession"]({
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  session: {
    id: "session-1",
    title: "Session 1",
    providerId: "codex",
    workspaceKey: "unvalidated-workspace",
    workspacePath: "C:\\workspace",
    localRepositoryKey: null,
    repositoryName: null,
    allowedAdditionalDirectories: [],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 1,
  },
});
