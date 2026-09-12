import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionExecutionStorageV6, SessionExecutionWorkItemAssociationError } from "../../src-electron/session-execution-storage-v6.js";
import { verifyResourceHistoryProjections } from "../../src-electron/resource-history-schema.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";
import { resolveActualStartSourceIdentity } from "../../src-electron/work-item-source-admission.js";
import { projectSessionExecution } from "../../src/session-external-runtime-contract.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "withmate-source-admission-"));
  git(root, ["init", "--initial-branch", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "WithMate Test"]);
  writeFileSync(path.join(root, "README"), "source\n", "utf8");
  git(root, ["add", "README"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const EXPIRES_AT = "2026-08-11T00:00:00.000Z";
function proof(operation: "turn.run" | "turn.enqueue"): MutationAuthorityProof {
  return { principal: { kind: "system", service: "source-admission-test" }, operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: operation, resolvedScope: { resourceKind: "execution", resourceId: null, rootSessionId: "session-1", ownerKind: "session", ownerId: "session-1", relation: "self" },
    effectClass: "external_side_effect", grantId: null, grantRevision: null, evaluatedAt: CREATED_AT };
}

async function createStorageFixture(workspacePath = process.cwd()): Promise<{ directory: string; dbPath: string; storage: SessionExecutionStorageV6; db: DatabaseSync }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-source-storage-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,workspace_path,created_at,updated_at,last_active_at) VALUES (?,?,'active','codex',1,'gpt-5','on-request',?,?,?,?)")
    .run("session-1", "Session 1", workspacePath, CREATED_AT, CREATED_AT, CREATED_AT);
  insertStandaloneRoleBindingsForSessions(db);
  db.prepare("INSERT INTO work_items_v6 (id,kind,contract_revision,root_session_id,creator_session_id,target_session_id,parent_work_item_id,goal,scope,completion_criteria,authority,source_identity_json,state,revision,created_at,updated_at) VALUES (?, 'root', 2, ?, ?, ?, NULL, 'goal','scope','done','authority',?,'pending',1,?,?)")
    .run("work-1", "session-1", "session-1", "session-1", JSON.stringify({ workspace: "planned", repository: null, branch: "main", base: null, head: null }), CREATED_AT, CREATED_AT);
  const storage = new SessionExecutionStorageV6(dbPath);
  return { directory, dbPath, storage, db };
}

// @test-value v2
// kind = "invariant"
// claim = "execution admission atomically stores Work Item revision, planned source, and actual source"
// fault = "execution row commits without its immutable Work Item source association"
// observable = "execution association row and execution event payload"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "SessionExecutionStorageV6 source admission"
// lifecycle = "permanent"
// @end-test-value
test("同期running作成はrevision/planned/actual sourceを同時保存する", async () => {
  const fixture = await createStorageFixture();
  try {
    const execution = fixture.storage.startImmediate({ id: "exec-1", expectedContainerRevision: fixture.storage.getSessionContainerRevision("session-1"), sessionId: "session-1", request: { userMessage: "run" }, idempotencyKey: "run-1", requestFingerprint: "run-1", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: proof("turn.run"), workItemId: "work-1" }).execution;
    assert.equal(execution.workItemRevision, 1);
    assert.equal(execution.plannedSourceIdentity?.workspace, "planned");
    assert.equal(execution.actualStartSourceIdentity?.kind, "resolved");
    const publicExecution = projectSessionExecution(execution, { workItemId: "work-1" });
    assert.equal(publicExecution.workItemRevision, 1);
    assert.equal(publicExecution.actualStartSourceIdentity?.kind, "resolved");
    const row = fixture.db.prepare("SELECT work_item_revision,planned_source_json,actual_source_json FROM work_item_execution_associations_v6 WHERE execution_id='exec-1'").get() as { work_item_revision: number; planned_source_json: string; actual_source_json: string };
    assert.equal(row.work_item_revision, 1);
    assert.deepEqual(JSON.parse(row.planned_source_json), { workspace: "planned", repository: null, branch: "main", base: null, head: null });
    assert.match(row.actual_source_json, /"kind":"resolved"/);
    const event = fixture.db.prepare("SELECT payload_json FROM session_execution_events_v6 WHERE execution_id='exec-1' ORDER BY revision DESC LIMIT 1").get() as { payload_json: string };
    const eventPayload = JSON.parse(event.payload_json) as { projection?: Record<string, unknown> };
    assert.deepEqual(eventPayload.projection?.plannedSourceIdentity, { workspace: "planned", repository: null, branch: "main", base: null, head: null });
    assert.deepEqual(eventPayload.projection?.actualStartSourceIdentity, execution.actualStartSourceIdentity);
  } finally { fixture.db.close(); fixture.storage.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "queued admission rejects an association whose Work Item revision changed after enqueue"
// fault = "queued execution runs against a stale Work Item contract"
// observable = "admission error and execution state"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "SessionExecutionStorageV6 source admission"
// lifecycle = "permanent"
// @end-test-value
test("queued後のWork Item revision変更はadmissionを拒否する", async () => {
  const fixture = await createStorageFixture();
  try {
    const queued = fixture.storage.enqueue({ id: "exec-2", expectedContainerRevision: fixture.storage.getSessionContainerRevision("session-1"), sessionId: "session-1", request: { userMessage: "queued" }, idempotencyKey: "queue-1", requestFingerprint: "queue-1", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: proof("turn.enqueue"), workItemId: "work-1" }).execution;
    fixture.db.prepare("UPDATE work_items_v6 SET revision=2 WHERE id='work-1'").run();
    assert.throws(() => fixture.storage.admitNextQueued("session-1", EXPIRES_AT), SessionExecutionWorkItemAssociationError);
    assert.equal(fixture.storage.get(queued.id)?.state, "queued");
  } finally { fixture.db.close(); fixture.storage.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "queued Work Item admission rejects an association without a canonical workspace"
// fault = "admission proceeds with a null actual source when the target Session has no canonical workspace"
// observable = "association actual source, admission error, and queued state"
// observation_boundary = "component-behavior"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "SessionExecutionStorageV6 canonical workspace admission"
// lifecycle = "permanent"
// @end-test-value
test("canonical workspace不明のqueued Work Itemはactual nullのままadmissionを拒否する", async () => {
  const fixture = await createStorageFixture("");
  try {
    const queued = fixture.storage.enqueue({ id: "exec-no-workspace", expectedContainerRevision: fixture.storage.getSessionContainerRevision("session-1"), sessionId: "session-1", request: { userMessage: "no workspace" }, idempotencyKey: "queue-no-workspace-1", requestFingerprint: "queue-no-workspace-1", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: proof("turn.enqueue"), workItemId: "work-1" }).execution;
    assert.equal(fixture.db.prepare("SELECT actual_source_json FROM work_item_execution_associations_v6 WHERE execution_id = ?").get(queued.id)?.actual_source_json, null);
    assert.throws(() => fixture.storage.admitNextQueued("session-1", EXPIRES_AT), SessionExecutionWorkItemAssociationError);
    assert.equal(fixture.storage.get(queued.id)?.state, "queued");
    assert.equal(fixture.db.prepare("SELECT actual_source_json FROM work_item_execution_associations_v6 WHERE execution_id = ?").get(queued.id)?.actual_source_json, null);
  } finally { fixture.db.close(); fixture.storage.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "queued admission stores actual source and replay rejects association tampering"
// fault = "queued execution loses its admitted source snapshot or startup replay accepts a changed association"
// observable = "running association, reopened execution, and resource history verification"
// observation_boundary = "component-behavior"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "SessionExecutionStorageV6 queued source admission"
// lifecycle = "permanent"
// @end-test-value
test("queued admissionのactual snapshotは再open後も保持しtamperを拒否する", async () => {
  const repository = createRepository();
  const fixture = await createStorageFixture(repository);
  try {
    const queued = fixture.storage.enqueue({ id: "exec-queued", expectedContainerRevision: fixture.storage.getSessionContainerRevision("session-1"), sessionId: "session-1", request: { userMessage: "queued" }, idempotencyKey: "queue-success-1", requestFingerprint: "queue-success-1", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: proof("turn.enqueue"), workItemId: "work-1" }).execution;
    git(repository, ["checkout", "--detach", "HEAD"]);
    const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const admitted = fixture.storage.admitNextQueued("session-1", EXPIRES_AT);
    assert.equal(admitted?.id, queued.id);
    assert.equal(admitted?.state, "running");
    assert.equal(admitted?.actualStartSourceIdentity?.kind, "detached_head");
    assert.equal(admitted?.actualStartSourceIdentity?.head, expectedHead);
    fixture.storage.close();
    fixture.db.close();
    const reopened = new SessionExecutionStorageV6(fixture.dbPath);
    assert.equal(reopened.get(queued.id)?.actualStartSourceIdentity?.kind, "detached_head");
    reopened.close();
    const tamperedDb = new DatabaseSync(fixture.dbPath);
    try {
      tamperedDb.prepare("UPDATE work_item_execution_associations_v6 SET actual_source_json = NULL WHERE execution_id = ?").run(queued.id);
      let startupRejected = false;
    let tamperedStorage: SessionExecutionStorageV6 | undefined;
    try {
      tamperedStorage = new SessionExecutionStorageV6(fixture.dbPath);
    } catch {
      startupRejected = true;
    } finally {
      tamperedStorage?.close();
    }
      assert.equal(startupRejected, true);
      assert.throws(() => verifyResourceHistoryProjections(tamperedDb));
      tamperedDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { tamperedDb.close(); }
  } finally {
    await Promise.all([
      rm(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined),
      rm(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ]);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "archive済みWork Itemは新規execution associationの対象にならない"
// fault = "archived Work Itemへexecutionを関連付けてdispatchする"
// observable = "association作成時のdomain error"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "SessionExecutionStorageV6 Work Item admission"
// lifecycle = "permanent"
// @end-test-value
test("archive済みWork Itemのenqueueを拒否する", async () => {
  const fixture = await createStorageFixture();
  try {
    fixture.db.prepare("UPDATE work_items_v6 SET archived_at = ? WHERE id = 'work-1'").run(EXPIRES_AT);
    assert.throws(() => fixture.storage.enqueue({ id: "exec-archived", expectedContainerRevision: fixture.storage.getSessionContainerRevision("session-1"), sessionId: "session-1", request: { userMessage: "archived" }, idempotencyKey: "archive-1", requestFingerprint: "archive-1", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: proof("turn.enqueue"), workItemId: "work-1" }), SessionExecutionWorkItemAssociationError);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get()?.count, 0);
  } finally { fixture.db.close(); fixture.storage.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "admission source resolution distinguishes Git-unavailable workspaces from valid repositories"
// fault = "actual source resolution treats a Git-unavailable workspace as a resolved repository"
// observable = "actual source kind and all Git tuple fields"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "source admission resolver"
// lifecycle = "permanent"
// @end-test-value
test("Git外workspaceはgit_unavailableとして保存可能なstrict snapshotになる", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "withmate-no-git-"));
  try {
    const actual = resolveActualStartSourceIdentity(root);
    assert.deepEqual(actual, { kind: "git_unavailable", workspace: root.replace(/\\/g, "/"), repository: null, branch: null, base: null, head: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "admission source resolution captures a symbolic branch and HEAD for a normal repository"
// fault = "repository is on a named branch with a commit"
// observable = "resolved source kind, branch, and head"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "source admission resolver"
// lifecycle = "permanent"
// @end-test-value
test("通常のrepositoryはbranchとHEADをresolvedとして取得する", async () => {
  const root = createRepository();
  try {
    const actual = resolveActualStartSourceIdentity(root);
    assert.equal(actual.kind, "resolved");
    assert.equal(actual.branch, "main");
    assert.equal(actual.base, null);
    assert.match(actual.head, /^[0-9a-f]{40}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "admission source resolution distinguishes detached HEAD from an unborn branch"
// fault = "repository checkout state changes after queue registration"
// observable = "strict source kind and branch/head nullability"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "source admission resolver"
// lifecycle = "permanent"
// @end-test-value
test("detached HEADとunborn branchを区別する", async () => {
  const detached = createRepository();
  const unborn = mkdtempSync(path.join(os.tmpdir(), "withmate-unborn-"));
  try {
    git(detached, ["checkout", "--detach", "HEAD"]);
    const detachedActual = resolveActualStartSourceIdentity(detached);
    assert.equal(detachedActual.kind, "detached_head");
    assert.equal(detachedActual.branch, null);
    assert.match(detachedActual.head, /^[0-9a-f]{40}$/);
    git(unborn, ["init", "--initial-branch", "feature"]);
    const unbornActual = resolveActualStartSourceIdentity(unborn);
    assert.equal(unbornActual.kind, "unborn_branch");
    assert.equal(unbornActual.branch, "feature");
    assert.equal(unbornActual.head, null);
  } finally {
    await Promise.all([rm(detached, { recursive: true, force: true }), rm(unborn, { recursive: true, force: true })]);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Git command failures are rejected instead of classified as a normal repository state"
// fault = "a corrupt HEAD is misclassified as detached or unborn and execution proceeds"
// observable = "source resolver domain error"
// observation_boundary = "component-behavior"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "source admission resolver"
// lifecycle = "permanent"
// @end-test-value
test("破損したGit HEADはunbornやdetachedへ救済しない", async () => {
  const root = createRepository();
  try {
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/\n", "utf8");
    assert.throws(() => resolveActualStartSourceIdentity(root), /Git/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
