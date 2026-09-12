import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import type { SessionRuntimeProviderTuple } from "../../src/session-external-runtime-contract.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { SessionLifecycleResolver } from "../../src-electron/session-lifecycle-resolver.js";
import { SessionLifecycleRecoveryError, SessionLifecycleService } from "../../src-electron/session-lifecycle-service.js";
import { SessionCrudError } from "../../src-electron/session-crud-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { WorkItemService } from "../../src-electron/work-item-service.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";

const catalog = {
  revision: 7,
  providers: [{
    id: "codex",
    label: "Codex",
    defaultModelId: "model-a",
    defaultReasoningEffort: "low",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: ["low", "high"] }],
  }],
};

const character: CharacterCatalogEntry = {
  id: "character-a", name: "Character A", description: "", iconFilePath: "",
  theme: { main: "#123456", sub: "#654321" }, state: "active",
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", archivedAt: null,
};

const snapshot: CharacterRuntimeSnapshot = {
  characterId: character.id, name: character.name, description: "", iconFilePath: "",
  theme: character.theme, definitionMarkdown: "# Character A", definitionSha256: "character-a-sha",
  definitionByteSize: 13, snapshotAt: "2026-08-01T00:00:00.000Z",
};

function proof(operation: MutationAuthorityProof["operation"], sessionId: string, rootSessionId = sessionId, resourceId: string | null = sessionId): MutationAuthorityProof {
  return {
    principal: { kind: "user", receiptId: "gui-test" }, operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: operation,
    resolvedScope: { resourceKind: operation === "session.create" ? "session_namespace" : "session", resourceId,
    rootSessionId, ownerKind: "session", ownerId: sessionId, relation: "self" },
    effectClass: "local_mutation", grantId: null, grantRevision: null, evaluatedAt: "2026-09-08T00:00:00.000Z",
  };
}

function provider(threadContinuity: "continue" | "reset" = "reset"): SessionRuntimeProviderTuple {
  return { id: "codex", catalogRevision: 7, model: "model-a", reasoningEffort: "low", threadContinuity,
    approvalMode: "untrusted", codexSandboxMode: "workspace-write", allowedAdditionalDirectories: [] };
}

async function makeService(dbPath: string, overrides: {
  createFolder?: (sessionId: string) => Promise<void>;
  cleanupFolder?: (sessionId: string) => Promise<void>;
  publish?: (session: import("../../src/session-state.js").Session) => void;
  publishRemoved?: (sessionId: string) => Promise<void>;
  createSessionId?: () => string;
} = {}): Promise<{ service: SessionLifecycleService; storage: SessionStorageV6; close(): void }> {
  const storage = new SessionStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(character.id, character.name, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  db.close();
  const resolver = new SessionLifecycleResolver({
    currentModelCatalog: () => catalog,
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    listCharacters: () => [character],
    createCharacterRuntimeSnapshot: () => snapshot,
    resolveSessionFilesDirectory: (id) => path.join(path.dirname(dbPath), "session-files", id),
  });
  const service = new SessionLifecycleService({
    storage, resolver,
    createSessionFilesDirectory: overrides.createFolder ?? (async () => undefined),
    cleanupSessionFilesDirectory: overrides.cleanupFolder ?? (async () => undefined),
    resolveSessionFilesDirectory: (id) => path.join(path.dirname(dbPath), "session-files", id),
    publishSession: (session) => overrides.publish?.(session),
    publishRemovedSession: overrides.publishRemoved ?? (async () => undefined),
    createSessionId: overrides.createSessionId ?? (() => "session-created"),
  });
  return { service, storage, close: () => storage.close() };
}

function createInput(idempotencyKey: string) {
  return {
    expectedContainerRevision: 0, placement: { kind: "root", rootKind: "standalone" as const }, title: "Initial title",
    character: { characterId: character.id, expectedDefinitionSha256: snapshot.definitionSha256 }, provider: provider(),
    workspace: { kind: "session_folder" as const }, initialGrant: { kind: "inherit" as const }, budget: { kind: "inherit" as const }, idempotencyKey,
  };
}

function workBinding(sessionId: string): ResolvedAgentRuntimeBinding {
  return { bindingId: "binding-" + sessionId, bindingIdHash: "hash-" + sessionId, actorSessionId: sessionId,
    providerId: "codex", executionGeneration: "generation-1", authoritySnapshot: {}, operationGrants: ["session.runtime.invoke"],
    createdAt: "2026-09-08T00:00:00.000Z", expiresAt: null };
}

function parentConstructionProof(dbPath: string, rootSessionId: string): MutationAuthorityProof {
  const db = new DatabaseSync(dbPath);
  try {
    const grant = db.prepare("SELECT grant_id, revision FROM session_authority_grants_v6 WHERE grantee_session_id = ? AND actions_json LIKE '%session.create%' AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1").get(rootSessionId) as { grant_id: string; revision: number } | undefined;
    if (!grant) throw new Error("Parent Session construction grant was not created.");
    return { principal: { kind: "agent", actorSessionId: rootSessionId, grantId: grant.grant_id, grantRevision: grant.revision }, operation: "session.create",
      mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "session.create", effectClass: "local_mutation", grantId: grant.grant_id, grantRevision: grant.revision,
      evaluatedAt: "2026-09-08T00:00:00.000Z", resolvedScope: { resourceKind: "session_namespace", resourceId: null, rootSessionId, ownerKind: "session", ownerId: rootSessionId, relation: "self" } };
  } finally { db.close(); }
}

function completeRootWorkItem(dbPath: string, sessionId: string): void {
  const storage = new WorkItemStorageV6(dbPath);
  const item = storage.get(`root-work-item:${sessionId}`);
  if (!item) throw new Error("Root Work Item was not created with the root Session.");
  const service = new WorkItemService({
    storage,
    getTurnAuthoritySession: (id) => id === sessionId ? {
      sessionId: id, title: "Initial title", sessionRole: "standalone", roleContractRevision: 1,
      rootSessionId: id, parentSessionId: null, delegationDepth: 0,
    } : null,
    createWorkItemId: () => "unused-work-item",
    currentTimestamp: () => "2026-09-08T00:00:00.000Z",
  });
  try {
    const started = service.transition({ workItemId: item.id, state: "in_progress", expectedRevision: item.revision, idempotencyKey: "root-start-key" }, workBinding(sessionId), {
      principal: { kind: "user", receiptId: "work-owner-test" }, operation: "work.transition",
      mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "work.transition", effectClass: "local_mutation",
      grantId: null, grantRevision: null, evaluatedAt: "2026-09-08T00:00:00.000Z",
      resolvedScope: { resourceKind: "work_item", resourceId: item.id, rootSessionId: sessionId, ownerKind: "session", ownerId: sessionId, relation: "self" },
    });
    service.reportResult({
      workItemId: item.id, state: "completed", expectedRevision: started.revision,
      result: { summary: "done", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [] },
      idempotencyKey: "root-result-key",
    }, workBinding(sessionId), {
      principal: { kind: "user", receiptId: "work-owner-test" }, operation: "work.result",
      mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "work.result", effectClass: "local_mutation",
      grantId: null, grantRevision: null, evaluatedAt: "2026-09-08T00:00:00.000Z",
      resolvedScope: { resourceKind: "work_item", resourceId: item.id, rootSessionId: sessionId, ownerKind: "session", ownerId: sessionId, relation: "self" },
    });
  } finally {
    storage.close();
  }
}

// @test-value v2
// kind = "invariant"
// claim = "SessionLifecycleService configure/archive/restore persists runtime settings while preserving an existing SessionFolder in the real V6 database."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Direct validation" }
// fault = "Lifecycle operations update an in-memory projection without atomically persisting the Session state."
// observable = "SessionStorageV6 lifecycle Session rows, stored runtime policy settings, and resource revisions"
// observation_boundary = "component-behavior"
// scope = "SessionLifecycleService create configure archive restore with existing SessionFolder"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService は実DBで create→configure(title/runtime)→archive→restore を保持する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-"));
  await mkdir(path.join(root, "session-files"));
  let removedPublications = 0;
  const { service, storage, close } = await makeService(path.join(root, "app.db"), {
    createFolder: async (sessionId) => { await mkdir(path.join(root, "session-files", sessionId)); },
    publishRemoved: async () => { removedPublications += 1; if (removedPublications === 1) throw new Error("archive response lost"); },
  });
  try {
    const created = await service.create(createInput("create-key"), proof("session.create", "session-created"));
    assert.equal(created.title, "Initial title");
    const guiUpdate = await service.updateSession({ ...storage.getLifecycleSession("session-created")!, codexSpeed: "fast", codexReviewer: "auto-review" });
    assert.equal(guiUpdate.codexSpeed, "fast");
    assert.equal(guiUpdate.codexReviewer, "auto-review");
    const guiSnapshotDb = new DatabaseSync(path.join(root, "app.db"));
    const guiSnapshot = JSON.parse((guiSnapshotDb.prepare("SELECT runtime_policy_json FROM sessions_v6 WHERE id = ?").get("session-created") as { runtime_policy_json: string }).runtime_policy_json) as { codexSpeed: string; codexReviewer: string };
    guiSnapshotDb.close();
    assert.equal(guiSnapshot.codexSpeed, "fast");
    assert.equal(guiSnapshot.codexReviewer, "auto-review");
    let revision = storage.getSessionResourceRevision("session-created")!;
    const title = await service.configure({ sessionId: "session-created", expectedRevision: revision, kind: "title", title: "Renamed", idempotencyKey: "title-key" }, proof("session.configure", "session-created"));
    assert.equal(title.title, "Renamed");
    revision = storage.getSessionResourceRevision("session-created")!;
    await service.configure({ sessionId: "session-created", expectedRevision: revision, kind: "runtime", provider: provider("continue"), idempotencyKey: "runtime-key" }, proof("session.configure", "session-created"));
    revision = storage.getSessionResourceRevision("session-created")!;
    const runtimeDb = new DatabaseSync(path.join(root, "app.db"));
    const runtimeRow = runtimeDb.prepare("SELECT provider_id, model_id, reasoning_effort, thread_id, catalog_revision FROM sessions_v6 WHERE id = ?").get("session-created") as { provider_id: string; model_id: string; reasoning_effort: string; thread_id: string; catalog_revision: number };
    runtimeDb.close();
    assert.deepEqual({ ...runtimeRow }, { provider_id: "codex", model_id: "model-a", reasoning_effort: "low", thread_id: "", catalog_revision: 7 });
    completeRootWorkItem(path.join(root, "app.db"), "session-created");
    const predecessorDb = new DatabaseSync(path.join(root, "app.db"));
    const predecessor = predecessorDb.prepare("SELECT id, state, revision FROM work_items_v6 WHERE kind = 'root' AND root_session_id = ? ORDER BY sequence DESC LIMIT 1").get("session-created") as { id: string; state: string; revision: number };
    const predecessorHistoryCount = (predecessorDb.prepare("SELECT COUNT(*) AS count FROM work_item_events_v6 WHERE work_item_id = ?").get(predecessor.id) as { count: number }).count;
    const budgetBeforeArchive = predecessorDb.prepare("SELECT account_id, revision FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").get("session-created") as { account_id: string; revision: number };
    predecessorDb.close();
    assert.equal(predecessor.state, "completed");
    assert.ok(predecessorHistoryCount >= 2);
    const archiveInput = { sessionId: "session-created", expectedRevision: revision, reason: "done", descendantPolicy: "retain" as const, idempotencyKey: "archive-key" };
    const archiveProof = proof("session.archive", "session-created");
    await assert.rejects(service.archive(archiveInput, archiveProof), (error) => error instanceof SessionLifecycleRecoveryError);
    const archived = await service.archive(archiveInput, archiveProof);
    assert.equal(removedPublications, 2);
    assert.equal(storage.getLifecycleSession("session-created") , null);
    const stateDb = new DatabaseSync(path.join(root, "app.db"));
    assert.equal((stateDb.prepare("SELECT state FROM sessions_v6 WHERE id = ?").get("session-created") as { state: string }).state, "archived");
    const archivedRevision = (stateDb.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get("session-created") as { resource_revision: number }).resource_revision;
    stateDb.close();
    const restored = await service.restore({ sessionId: "session-created", expectedRevision: storage.getSessionResourceRevision("session-created")!, kind: "root", purpose: "Continue", provider: provider(), budget: { kind: "inherit" }, idempotencyKey: "restore-key" }, proof("session.restore", "session-created"));
    assert.equal(restored.title, "Continue");
    assert.equal(storage.getLifecycleSession("session-created")?.status, "idle");
    assert.ok(storage.getSessionResourceRevision("session-created")! > revision);
    assert.equal(archived.title, "Renamed");
    const restoredDb = new DatabaseSync(path.join(root, "app.db"));
    const workItems = restoredDb.prepare("SELECT id, predecessor_work_item_id, state FROM work_items_v6 WHERE kind = 'root' AND root_session_id = ? ORDER BY sequence").all("session-created") as Array<{ id: string; predecessor_work_item_id: string | null; state: string }>;
    const budgetAfterRestore = restoredDb.prepare("SELECT account_id, revision FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").get("session-created") as { account_id: string; revision: number };
    const restoredRevision = (restoredDb.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get("session-created") as { resource_revision: number }).resource_revision;
    restoredDb.close();
    assert.equal(restoredRevision, archivedRevision + 1);
    assert.equal(workItems.length, 2);
    assert.equal(workItems[0].id, predecessor.id);
    assert.equal(workItems[0].state, "completed");
    assert.equal(workItems[1].predecessor_work_item_id, predecessor.id);
    assert.equal(workItems[1].state, "pending");
    assert.equal(budgetAfterRestore.account_id, budgetBeforeArchive.account_id);
    assert.equal(budgetAfterRestore.revision, budgetBeforeArchive.revision + 1);
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Session のタイトルだけを更新するGUI要求は、catalog revision が更新済みでも既存 configure(title) 経路で保存できる。"
// oracle = { type = "contract", ref = "src-electron/session-lifecycle-service.ts#updateSession" }
// fault = "タイトル変更でもProvider tupleを再検証し、catalog revision staleとして保存を拒否する。"
// observable = "SessionLifecycleService の返却SessionとDB-backed lifecycle SessionのtaskTitle"
// observation_boundary = "component-behavior"
// scope = "SessionLifecycleService.updateSession title-only request with stale catalog"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はcatalog更新後もタイトルだけのGUI更新を保存する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-title-"));
  await mkdir(path.join(root, "session-files"));
  const { service, storage, close } = await makeService(path.join(root, "app.db"));
  try {
    await service.create(createInput("title-create-key"), proof("session.create", "session-created"));
    const current = storage.getLifecycleSession("session-created")!;
    catalog.revision = 8;
    const updated = await service.updateSession({ ...current, taskTitle: "Renamed after catalog update" });
    assert.equal(updated.taskTitle, "Renamed after catalog update");
    assert.equal(storage.getLifecycleSession("session-created")?.taskTitle, "Renamed after catalog update");
    await assert.rejects(
      service.updateSession({ ...current, codexSpeed: "fast" }),
      (error) => error instanceof SessionCrudError && error.code === "CATALOG_REVISION_STALE",
    );
  } finally {
    catalog.revision = 7;
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Child Session restore does not create a Root WorkItem successor."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Direct validation" }
// fault = "A child restore mutates root WorkItem history or creates a second root successor."
// observable = "Root WorkItem count and restored child binding"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService child restore"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はchild restoreでRoot WorkItem successorを作らない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-child-"));
  let nextId = 0;
  const { service, storage, close } = await makeService(path.join(root, "app.db"), { createSessionId: () => nextId++ === 0 ? "session-root" : "session-child" });
  try {
    await service.create({ ...createInput("root-key"), title: "Root", placement: { kind: "root", rootKind: "overall-coordinator" } }, proof("session.create", "session-root", "session-root", null));
    const child = await service.create({ ...createInput("child-key"), title: "Child", expectedContainerRevision: storage.getSessionResourceRevision("session-root")!, placement: { kind: "child", parentSessionId: "session-root", sessionRole: "executor" } }, parentConstructionProof(path.join(root, "app.db"), "session-root"));
    const childBeforeArchive = storage.getLifecycleSession(child.sessionId, true)!;
    const childRevision = storage.getSessionResourceRevision(child.sessionId)!;
    await service.archive({ sessionId: child.sessionId, expectedRevision: childRevision, reason: "pause", descendantPolicy: "retain", idempotencyKey: "child-archive" }, proof("session.archive", child.sessionId, "session-root"));
    const beforeDb = new DatabaseSync(path.join(root, "app.db"));
    const rootWorkItemsBefore = beforeDb.prepare("SELECT id, state, revision, predecessor_work_item_id FROM work_items_v6 WHERE kind = 'root' AND root_session_id = ? ORDER BY sequence").all("session-root") as Array<{ id: string; state: string; revision: number; predecessor_work_item_id: string | null }>;
    beforeDb.close();
    const restored = await service.restore({ sessionId: child.sessionId, expectedRevision: storage.getSessionResourceRevision(child.sessionId)!, kind: "child", purpose: "Resume child", provider: provider("reset"), idempotencyKey: "child-restore" }, proof("session.restore", child.sessionId, "session-root"));
    assert.equal(restored.sessionId, child.sessionId);
    const restoredStored = storage.getLifecycleSession(child.sessionId, true)!;
    assert.equal(restoredStored.roleBinding?.rootSessionId, childBeforeArchive.roleBinding?.rootSessionId);
    assert.equal(restoredStored.roleBinding?.parentSessionId, childBeforeArchive.roleBinding?.parentSessionId);
    assert.equal(restoredStored.roleBinding?.sessionRole, childBeforeArchive.roleBinding?.sessionRole);
    assert.equal(restoredStored.threadId, "");
    assert.equal(restoredStored.status, "idle");
    const db = new DatabaseSync(path.join(root, "app.db"));
    assert.deepEqual(db.prepare("SELECT id, state, revision, predecessor_work_item_id FROM work_items_v6 WHERE kind = 'root' AND root_session_id = ? ORDER BY sequence").all("session-root"), rootWorkItemsBefore);
    db.close();
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "archive_descendants rejects an active descendant execution atomically and archives the root and idle descendants together."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Archive、tombstone delete、physical purge" }
// fault = "Archive partially changes the root or descendants before detecting an active descendant execution."
// observable = "Unchanged revisions after rejection and archived root/child states after the execution stops"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService archive descendant policy"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はactive descendantを持つarchiveを拒否し停止後に親子をarchiveする", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-archive-policy-"));
  let nextId = 0;
  const dbPath = path.join(root, "app.db");
  const { service, storage, close } = await makeService(dbPath, { createSessionId: () => nextId++ === 0 ? "session-root" : "session-child" });
  try {
    await service.create({ ...createInput("root-key"), title: "Root", placement: { kind: "root", rootKind: "overall-coordinator" } }, proof("session.create", "session-root", "session-root", null));
    const child = await service.create({ ...createInput("child-key"), title: "Child", expectedContainerRevision: storage.getSessionResourceRevision("session-root")!, placement: { kind: "child", parentSessionId: "session-root", sessionRole: "executor" } }, parentConstructionProof(dbPath, "session-root"));
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO session_executions_v6 (id, session_id, operation, state, request_json, created_at, updated_at) VALUES (?, ?, 'turn.run', 'running', '{}', ?, ?)").run("execution-child", child.sessionId, "2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    db.close();
    const rootRevision = storage.getSessionResourceRevision("session-root")!;
    const childRevision = storage.getSessionResourceRevision(child.sessionId)!;
    await assert.rejects(service.archive({ sessionId: "session-root", expectedRevision: rootRevision, reason: "all", descendantPolicy: "archive_descendants", idempotencyKey: "archive-all" }, proof("session.archive", "session-root")), (error) => error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT");
    assert.equal(storage.getLifecycleSession("session-root")?.status, "idle");
    assert.equal(storage.getLifecycleSession(child.sessionId)?.status, "idle");
    assert.equal(storage.getSessionResourceRevision("session-root"), rootRevision);
    assert.equal(storage.getSessionResourceRevision(child.sessionId), childRevision);
    const cleanupDb = new DatabaseSync(dbPath);
    cleanupDb.prepare("DELETE FROM session_executions_v6 WHERE id = ?").run("execution-child");
    cleanupDb.close();
    assert.equal(storage.getLifecycleSession("session-root")?.status, "idle");
    assert.equal(storage.getLifecycleSession(child.sessionId)?.status, "idle");
    const archivedTree = await service.archive({ sessionId: "session-root", expectedRevision: storage.getSessionResourceRevision("session-root")!, reason: "all", descendantPolicy: "archive_descendants", idempotencyKey: "archive-all-after-stop" }, proof("session.archive", "session-root"));
    assert.equal(archivedTree.sessionId, "session-root");
    assert.equal(storage.getLifecycleSession("session-root"), null);
    const archivedTreeDb = new DatabaseSync(dbPath);
    assert.equal((archivedTreeDb.prepare("SELECT state FROM sessions_v6 WHERE id = ?").get(child.sessionId) as { state: string }).state, "archived");
    archivedTreeDb.close();
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "A failed SessionFolder creation remains replayable with the same operation identity and does not create duplicate Session rows."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root 作成" }
// fault = "A retry after SessionFolder creation failure inserts a second Session or loses the prepared lifecycle operation."
// observable = "Folder callback count, operation identity/state, pending operation count, and stored Session count"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService create recovery"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はSessionFolder失敗後に同じcreateをreplayする", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-replay-"));
  let attempts = 0;
  const { service, storage, close } = await makeService(path.join(root, "app.db"), { createFolder: async () => { attempts += 1; if (attempts === 1) throw new Error("folder failed"); } });
  const input = createInput("replay-key");
  const userProof = proof("session.create", "session-created");
  try {
    await assert.rejects(service.create(input, userProof), (error) => error instanceof SessionLifecycleRecoveryError);
    assert.equal(storage.getLifecycleSession("session-created"), null);
    assert.equal(storage.listPendingLifecycleOperations().length, 1);
    const pendingDb = new DatabaseSync(path.join(root, "app.db"));
    const pendingRecord = pendingDb.prepare("SELECT operation_id, state FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get("replay-key") as { operation_id: string; state: string };
    pendingDb.close();
    assert.equal(pendingRecord.state, "prepared");
    await service.create(input, userProof);
    assert.equal(attempts, 2);
    assert.equal(storage.listSessions().filter((session) => session.id === "session-created").length, 1);
    assert.equal(storage.listPendingLifecycleOperations().length, 0);
    const committedDb = new DatabaseSync(path.join(root, "app.db"));
    const committedRecord = committedDb.prepare("SELECT operation_id, state, current_step FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get("replay-key") as { operation_id: string; state: string; current_step: string };
    committedDb.close();
    assert.equal(committedRecord.operation_id, pendingRecord.operation_id);
    assert.deepEqual({ state: committedRecord.state, current_step: committedRecord.current_step }, { state: "committed", current_step: "terminal" });
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "A transient database failure after SessionFolder creation replays the same lifecycle operation without recreating the folder or duplicating owned records."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Failure timing" }
// fault = "Retrying a prepared filesystem effect recreates the strict SessionFolder or applies Session, grant, or budget persistence more than once."
// observable = "Strict mkdir call count, lifecycle effect state, pending operations, Session rows, authority grants, and budget accounts"
// observation_boundary = "component-behavior"
// scope = "SessionLifecycleService create filesystem effect replay"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はDB一時失敗後にfilesystem effectを記録して同じcreateを再実行する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-filesystem-effect-"));
  const dbPath = path.join(root, "app.db");
  await mkdir(path.join(root, "session-files"));
  let mkdirCalls = 0;
  const { service, storage, close } = await makeService(dbPath, {
    createFolder: async (sessionId) => {
      mkdirCalls += 1;
      await mkdir(path.join(root, "session-files", sessionId));
    },
  });
  const input = createInput("filesystem-effect-replay-key");
  const userProof = proof("session.create", "session-created");
  const originalCommit = storage.commitLifecycleMutation.bind(storage);
  let databaseFailures = 1;
  storage.commitLifecycleMutation = ((mutation) => {
    if (databaseFailures > 0) {
      databaseFailures -= 1;
      throw new Error("transient database failure");
    }
    return originalCommit(mutation);
  }) as typeof storage.commitLifecycleMutation;
  try {
    await assert.rejects(service.create(input, userProof), (error) => error instanceof SessionLifecycleRecoveryError);
    assert.equal(mkdirCalls, 1);
    const pendingDb = new DatabaseSync(dbPath);
    const pending = pendingDb.prepare("SELECT operation_id, state, current_step, effects_json FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get(input.idempotencyKey) as { operation_id: string; state: string; current_step: string; effects_json: string };
    const pendingCounts = {
      sessions: (pendingDb.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = ?").get("session-created") as { count: number }).count,
      grants: (pendingDb.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?").get("session-created") as { count: number }).count,
      budgets: (pendingDb.prepare("SELECT COUNT(*) AS count FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").get("session-created") as { count: number }).count,
    };
    pendingDb.close();
    assert.deepEqual({ state: pending.state, current_step: pending.current_step }, { state: "running", current_step: "filesystem" });
    assert.equal(JSON.parse(pending.effects_json).filesystem, "committed");
    assert.deepEqual(pendingCounts, { sessions: 0, grants: 0, budgets: 0 });
    assert.equal(storage.listPendingLifecycleOperations().length, 1);

    await service.create(input, userProof);
    assert.equal(mkdirCalls, 1);
    assert.equal(storage.listPendingLifecycleOperations().length, 0);
    assert.ok(storage.getLifecycleSession("session-created"));
    const committedDb = new DatabaseSync(dbPath);
    const committed = committedDb.prepare("SELECT operation_id, state, current_step FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get(input.idempotencyKey) as { operation_id: string; state: string; current_step: string };
    const committedCounts = {
      sessions: (committedDb.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = ?").get("session-created") as { count: number }).count,
      grants: (committedDb.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?").get("session-created") as { count: number }).count,
      budgets: (committedDb.prepare("SELECT COUNT(*) AS count FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").get("session-created") as { count: number }).count,
    };
    committedDb.close();
    assert.equal(committed.operation_id, pending.operation_id);
    assert.deepEqual({ state: committed.state, current_step: committed.current_step }, { state: "committed", current_step: "terminal" });
    assert.equal(committedCounts.sessions, 1);
    assert.ok(committedCounts.grants > 0);
    assert.ok(committedCounts.budgets > 0);
    await service.create(input, userProof);
    const replayDb = new DatabaseSync(dbPath);
    assert.deepEqual({
      sessions: (replayDb.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = ?").get("session-created") as { count: number }).count,
      grants: (replayDb.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?").get("session-created") as { count: number }).count,
      budgets: (replayDb.prepare("SELECT COUNT(*) AS count FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").get("session-created") as { count: number }).count,
    }, committedCounts);
    replayDb.close();
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "A publication failure after database commit is retried from the committed lifecycle record without another Session insert or revision increment."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Failure timing" }
// fault = "Retrying after publication failure re-applies the create mutation and changes the stored resource revision."
// observable = "Stored Session count, resource revision, and publication attempt count"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService committed publication recovery"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はcommit後publication失敗を再開して重複作成しない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-publish-"));
  let publications = 0;
  const { service, storage, close } = await makeService(path.join(root, "app.db"), { publish: () => { publications += 1; if (publications === 1) throw new Error("publish failed"); } });
  const input = createInput("publish-create-key");
  const userProof = proof("session.create", "session-created");
  try {
    await assert.rejects(service.create(input, userProof), (error) => error instanceof SessionLifecycleRecoveryError);
    const committedRevision = storage.getSessionResourceRevision("session-created");
    assert.ok(committedRevision !== null);
    const pendingDb = new DatabaseSync(path.join(root, "app.db"));
    const pendingRecord = pendingDb.prepare("SELECT operation_id, state FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get("publish-create-key") as { operation_id: string; state: string };
    pendingDb.close();
    await service.create(input, userProof);
    assert.equal(publications, 2);
    assert.equal(storage.listSessions().filter((session) => session.id === "session-created").length, 1);
    assert.equal(storage.getSessionResourceRevision("session-created"), committedRevision);
    assert.equal(storage.listPendingLifecycleOperations().length, 0);
    const committedDb = new DatabaseSync(path.join(root, "app.db"));
    const committedRecord = committedDb.prepare("SELECT operation_id, state, current_step FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get("publish-create-key") as { operation_id: string; state: string; current_step: string };
    committedDb.close();
    assert.equal(committedRecord.operation_id, pendingRecord.operation_id);
    assert.deepEqual({ state: committedRecord.state, current_step: committedRecord.current_step }, { state: "committed", current_step: "terminal" });
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "SessionLifecycleServiceのrecoverPendingはstorageのbatch上限を越えるpending operationも、pendingが空になるまで再取得して処理する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Direct validation" }
// fault = "listPendingの最初の100件だけを処理してstartup recoveryを成功扱いにする"
// observable = "pending operation count、committed lifecycle rows、publication attempt count、101件目を含む全pendingの処理完了"
// observation_boundary = "component-behavior"
// scope = "SessionLifecycleService recoverPending batching"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService は101件のpending publicationを全件startup recoveryする", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-recovery-batch-"));
  let nextSessionId = 0;
  let publicationFailure = true;
  const publishedSessionIds: string[] = [];
  const { service, storage, close } = await makeService(path.join(root, "app.db"), {
    createSessionId: () => `session-${++nextSessionId}`,
    publish: (session) => {
      publishedSessionIds.push(session.id);
      if (publicationFailure) throw new Error("publication unavailable");
    },
  });
  try {
    for (let index = 1; index <= 101; index += 1) {
      await assert.rejects(service.create(createInput(`recovery-batch-${index}`), proof("session.create", `session-${index}`)), SessionLifecycleRecoveryError);
    }
    assert.equal(publishedSessionIds.length, 101);
    publicationFailure = false;
    await service.recoverPending();
    assert.equal(storage.listPendingLifecycleOperations().length, 0);
    assert.equal(Array.from({ length: 101 }, (_, index) => storage.getLifecycleSession(`session-${index + 1}`)).filter(Boolean).length, 101);
    assert.equal(publishedSessionIds.length, 202);
    assert.equal(publishedSessionIds.slice(101).length, 101);
    assert.ok(publishedSessionIds.slice(101).includes("session-101"));
    const db = new DatabaseSync(path.join(root, "app.db"));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_operations_v6 WHERE operation = 'session.create' AND state = 'committed'").get() as { count: number }).count, 101);
    db.close();
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "session.deleteはmanifest guardを通過したSessionを同一transactionでtombstone化し、delete resource eventとrevision付き結果を保存する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Archive、tombstone delete、physical purge" }
// fault = "delete operationがSession rowを変更せずに成功扱いになるか、system fallback eventでproofを失う"
// observable = "deleted_at、resource revision、delete eventのoperation identityとproof、返却detail revision"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService delete mutation"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はmanifest guard後にSession delete tombstoneを保存する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-delete-"));
  const { service, storage, close } = await makeService(path.join(root, "app.db"));
  const db = new DatabaseSync(path.join(root, "app.db"));
  try {
    await service.create(createInput("delete-mutation-key"), proof("session.create", "session-created"));
    db.prepare("UPDATE work_items_v6 SET state = 'completed', result_json = '{\"outcome\":\"completed\"}' WHERE root_session_id = ? AND kind = 'root'").run("session-created");
    const manifest = service.deleteManifest("session-created");
    const expectedRevision = storage.getSessionResourceRevision("session-created");
    assert.ok(expectedRevision !== null);
    await assert.rejects(
      service.delete({ sessionId: "session-created", expectedRevision, manifestRevision: manifest.manifestRevision - 1, idempotencyKey: "stale-delete-key" }, proof("session.delete", "session-created")),
      /manifest has changed/i,
    );
    const detail = await service.delete({ sessionId: "session-created", expectedRevision, manifestRevision: manifest.manifestRevision, idempotencyKey: "delete-mutation-key" }, proof("session.delete", "session-created"));
    assert.equal(detail.sessionId, "session-created");
    assert.equal((detail as unknown as { revision: number }).revision, expectedRevision + 1);
    assert.equal(storage.getLifecycleSession("session-created"), null);
    const row = db.prepare("SELECT deleted_at, resource_revision FROM sessions_v6 WHERE id = ?").get("session-created") as { deleted_at: string | null; resource_revision: number };
    assert.ok(row.deleted_at);
    assert.equal(row.resource_revision, expectedRevision + 1);
    const event = db.prepare("SELECT event.event_kind, header.operation_id, header.principal_kind FROM session_resource_events_v6 AS event INNER JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id WHERE event.session_id = ? ORDER BY event.revision DESC LIMIT 1").get("session-created") as { event_kind: string; operation_id: string; principal_kind: string };
    const operation = db.prepare("SELECT operation_id, state, current_step FROM session_lifecycle_operations_v6 WHERE operation = 'session.delete' AND idempotency_key = ?").get("delete-mutation-key") as { operation_id: string; state: string; current_step: string };
    assert.equal(event.event_kind, "lifecycle.session.delete");
    assert.equal(event.operation_id, operation.operation_id);
    assert.equal(operation.state, "committed");
    assert.equal(operation.current_step, "terminal");
    assert.equal(event.principal_kind, "user");
  } finally {
    db.close();
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "deleteのDB tombstone後publication failureは同じidempotency requestのreplayで一度だけのrevisionと履歴を維持して完了する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Archive、tombstone delete、physical purge" }
// fault = "publication failure後の同key replayがSession revision、history、grantを二重更新する"
// observable = "pending operation数、resource revision、event/grant数、restore拒否"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService delete publication recovery"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はdelete publication failureを同じrequestでreplayする", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-delete-publication-replay-"));
  const dbPath = path.join(root, "app.db");
  let publicationFailures = 1;
  let publicationAttempts = 0;
  const { service, storage, close } = await makeService(dbPath, {
    publishRemoved: async () => {
      publicationAttempts += 1;
      if (publicationFailures > 0) { publicationFailures -= 1; throw new Error("publication unavailable"); }
    },
  });
  const db = new DatabaseSync(dbPath);
  try {
    await service.create(createInput("delete-replay-create"), proof("session.create", "session-created"));
    completeRootWorkItem(dbPath, "session-created");
    const expectedRevision = storage.getSessionResourceRevision("session-created")!;
    const manifest = service.deleteManifest("session-created");
    const request = { sessionId: "session-created", expectedRevision, manifestRevision: manifest.manifestRevision, idempotencyKey: "delete-replay-key" };
    const deleteProof = proof("session.delete", "session-created");
    await assert.rejects(service.delete(request, deleteProof), (error) => error instanceof SessionLifecycleRecoveryError && error.effect === "applied");
    assert.equal(publicationAttempts, 1);
    const committed = db.prepare("SELECT state, current_step FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get("delete-replay-key") as { state: string; current_step: string };
    assert.equal(committed.state, "running");
    assert.equal(committed.current_step, "db_committed");
    const tombstoneRevision = storage.getSessionResourceRevision("session-created", true);
    const eventCount = (db.prepare("SELECT COUNT(*) AS count FROM session_resource_events_v6 WHERE session_id = ?").get("session-created") as { count: number }).count;
    const grantCount = (db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?").get("session-created") as { count: number }).count;
    assert.equal(storage.listPendingLifecycleOperations().length, 1);
    const replay = await service.delete(request, deleteProof);
    assert.equal(replay.sessionId, "session-created");
    assert.equal(publicationAttempts, 2);
    const terminal = db.prepare("SELECT state, current_step FROM session_lifecycle_operations_v6 WHERE idempotency_key = ?").get("delete-replay-key") as { state: string; current_step: string };
    assert.equal(terminal.state, "committed");
    assert.equal(terminal.current_step, "terminal");
    assert.equal(storage.listPendingLifecycleOperations().length, 0);
    assert.equal(storage.getSessionResourceRevision("session-created", true), tombstoneRevision);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_resource_events_v6 WHERE session_id = ?").get("session-created") as { count: number }).count, eventCount);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?").get("session-created") as { count: number }).count, grantCount);
    await assert.rejects(service.restore({ sessionId: "session-created", expectedRevision: tombstoneRevision!, kind: "root", purpose: "restore deleted", provider: provider(), budget: { concurrentTurns: 1, queuedTurns: 1, workItems: 1, childSessions: 1 }, idempotencyKey: "restore-deleted" }, proof("session.restore", "session-created")), /not found/i);
  } finally {
    db.close();
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "deleted child is excluded from the parent's live manifest subtree so a terminal parent becomes deletable"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Archive、tombstone delete、physical purge" }
// fault = "parent manifest keeps a tombstoned child and permanently rejects normal parent deletion"
// observable = "child tombstone, parent manifest blockers, parent tombstone"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService parent child deletion"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService はchild delete後にparent manifestを再計算する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-delete-child-parent-"));
  const dbPath = path.join(root, "app.db");
  let nextId = 0;
  const { service, storage, close } = await makeService(dbPath, { createSessionId: () => nextId++ === 0 ? "session-root" : "session-child" });
  try {
    await service.create({ ...createInput("parent-create"), title: "Parent", placement: { kind: "root", rootKind: "overall-coordinator" } }, proof("session.create", "session-root", "session-root", null));
    const child = await service.create({ ...createInput("child-create"), title: "Child", expectedContainerRevision: storage.getSessionResourceRevision("session-root")!, placement: { kind: "child", parentSessionId: "session-root", sessionRole: "executor" } }, parentConstructionProof(dbPath, "session-root"));
    completeRootWorkItem(dbPath, "session-root");
    const blockedParentManifest = service.deleteManifest("session-root");
    assert.equal(blockedParentManifest.deletable, false);
    assert.ok(blockedParentManifest.blockers.includes("descendants_present"));
    const childManifest = service.deleteManifest(child.sessionId);
    await service.delete({ sessionId: child.sessionId, expectedRevision: storage.getSessionResourceRevision(child.sessionId)!, manifestRevision: childManifest.manifestRevision, idempotencyKey: "child-delete" }, proof("session.delete", child.sessionId, "session-root"));
    const childRow = new DatabaseSync(dbPath);
    try {
      assert.ok((childRow.prepare("SELECT deleted_at FROM sessions_v6 WHERE id = ?").get(child.sessionId) as { deleted_at: string | null }).deleted_at);
    } finally {
      childRow.close();
    }
    const parentManifest = service.deleteManifest("session-root");
    assert.equal(parentManifest.deletable, true);
    await service.delete({ sessionId: "session-root", expectedRevision: storage.getSessionResourceRevision("session-root")!, manifestRevision: parentManifest.manifestRevision, idempotencyKey: "parent-delete" }, proof("session.delete", "session-root"));
    assert.equal(storage.getLifecycleSession("session-root"), null);
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "regression"
// claim = "SessionLifecycleServiceのtombstone delete後に付随SessionFolder cleanupが失敗しても再開でき、外部Workspaceを削除しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Archive、tombstone delete、physical purge" }
// fault = "cleanup失敗で削除済みSessionが復活するか、再開がWorkspace自体を削除する"
// observable = "deleteのapplied error、tombstone revision不変、pending消化、folder不在とWorkspace存在"
// observation_boundary = "component-behavior"
// scope = "SessionLifecycleService tombstone cleanup recovery"
// lifecycle = "permanent"
// @end-test-value
test("GUI tombstone deleteは付随folderのcleanup失敗後に回復しWorkspaceを保持する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-delete-cleanup-"));
  const dbPath = path.join(root, "app.db");
  const workspace = path.join(root, "external-workspace");
  const folder = path.join(root, "session-files", "session-created");
  await mkdir(workspace);
  await mkdir(folder, { recursive: true });
  let cleanupAttempts = 0;
  const { service, storage, close } = await makeService(dbPath, {
    cleanupFolder: async (id) => {
      assert.equal(id, "session-created");
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("filesystem temporarily unavailable");
      await rm(folder, { recursive: true });
    },
  });
  try {
    await service.create({ ...createInput("directory-create"), workspace: { kind: "directory", path: workspace } }, proof("session.create", "session-created"));
    completeRootWorkItem(dbPath, "session-created");
    await assert.rejects(service.deleteSession("session-created", "tombstone"),
      (error) => error instanceof SessionLifecycleRecoveryError && error.effect === "applied");
    assert.equal(storage.getLifecycleSession("session-created", true), null);
    assert.equal(storage.listPendingLifecycleOperations().length, 1);
    const revision = storage.getSessionResourceRevision("session-created", true);
    await access(folder);
    await service.recoverPending();
    assert.equal(cleanupAttempts, 2);
    assert.equal(storage.listPendingLifecycleOperations().length, 0);
    assert.equal(storage.getSessionResourceRevision("session-created", true), revision);
    await assert.rejects(access(folder), { code: "ENOENT" });
    await access(workspace);
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});
