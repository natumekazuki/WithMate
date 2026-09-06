import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildNewSession } from "../../src/session-state.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAuthorityProof } from "../../src/session-authority.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { revokeSessionAuthorityGrant } from "../../src-electron/session-authority-storage.js";
import { SessionExecutionService } from "../../src-electron/session-execution-service.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { SessionTranscriptStorageV6 } from "../../src-electron/session-transcript-storage-v6.js";
import { MainSessionCommandFacade } from "../../src-electron/main-session-command-facade.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";

const NOW = "2026-09-07T00:00:00.000Z";
const EXPIRES = "2026-09-08T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-admission-regressions-"));
  const dbPath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(dbPath);
  const root = buildNewSession({
    id: "root", taskTitle: "Root", workspaceLabel: "workspace", workspacePath: directory,
    branch: "", characterId: "character-a", character: "A", approvalMode: "on-request",
    rootSessionRole: "overall-coordinator",
  });
  root.updatedAt = NOW;
  storage.insertSession(root);
  return { directory, dbPath, storage, root, async close() {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

function proof(operation: "session.files.write_text" | "transcript.export" | "turn.enqueue"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return {
    principal: { kind: "system", service: "admission-regression" }, operation,
    action: definition.action, effectClass: definition.effectClass,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    resolvedScope: { resourceKind: definition.resourceKind, resourceId: "root", rootSessionId: "root", ownerKind: "session", ownerId: "root", relation: "self" },
    grantId: null, grantRevision: null, evaluatedAt: NOW,
  };
}

// @test-value v2
// kind = "security"
// claim = "委譲で作成した子Sessionのrename権限を取り消した後、再起動しても権限が復活しない"
// oracle = { type = "contract", ref = "review-P1-delegated-restart" }
// fault = "再起動後に子Sessionの取り消したrename操作が再び許可される"
// observable = "再生成したauthority serviceのrename可否と子grant件数"
// observation_boundary = "component-behavior"
// risk_tags = ["authorization"]
// scope = "Session authority startup"
// lifecycle = "permanent"
// @end-test-value
test("委譲済み子のrevokeはschemaとauthority serviceの再起動後も有効", async () => {
  const f = await fixture();
  const options = { databasePath: f.dbPath, getExecutionGeneration: () => "generation", now: () => new Date(NOW) };
  let authority = new SessionAuthorityService(options);
  const db = new DatabaseSync(f.dbPath);
  try {
    const binding = { bindingId: "binding", bindingIdHash: "hash", actorSessionId: "root", providerId: "codex", executionGeneration: "generation", authoritySnapshot: {}, operationGrants: ["session.runtime.invoke"], createdAt: NOW, expiresAt: null };
    const parentProof = authority.authorize(binding, "session.create", { sessionRole: "executor" }).proof;
    const child = { ...f.root, id: "child", roleBinding: buildChildSessionRoleBinding("child", "root", f.root.roleBinding!, "executor") };
    f.storage.insertSessionIdempotently(child, {
      operation: "session.create", principalSessionId: "root", idempotencyKey: "child-create", requestFingerprint: "child-create",
      createdAt: NOW, expiresAt: EXPIRES, expectedContainerRevision: f.storage.getSessionResourceRevision("root")!,
      proof: parentProof, projectResult: (session) => ({ id: session.id }), resolveReplayFingerprint: () => "child-create",
    });
    const childProof = authority.authorize({ ...binding, actorSessionId: "child" }, "session.rename", { sessionId: "child" }).proof;
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM session_authority_grants_v6 WHERE grantee_session_id = 'child'").get() as { n: number }).n;
    const before = count();
    revokeSessionAuthorityGrant(db, { grantId: childProof.grantId!, expectedRevision: childProof.grantRevision!, principal: { kind: "system", service: "test" }, revokedAt: NOW });
    assert.equal(authority.canSessionAct("child", "session.rename", { sessionId: "child" }), false);
    authority.close();
    ensureV6Schema(db);
    authority = new SessionAuthorityService(options);
    assert.equal(count(), before);
    assert.equal(authority.canSessionAct("child", "session.rename", { sessionId: "child" }), false);
    assert.equal(authority.canSessionAct("child", "session.get", { sessionId: "child" }), true);
  } finally {
    authority.close(); db.close(); await f.close();
  }
});

// @test-value v2
// kind = "regression"
// claim = "GUI送信の非同期検証中にpinを変更してもexecutionを保存でき、明示revisionの古い要求は拒否する"
// oracle = { type = "contract", ref = "review-P2-gui-revision" }
// fault = "検証中のpin更新でGUI送信が失敗するか、古い明示revisionの要求でexecutionを保存する"
// observable = "GUIのok結果、永続execution件数、明示revision要求の競合例外"
// observation_boundary = "component-behavior"
// scope = "GUI execution admission"
// lifecycle = "permanent"
// @end-test-value
test("GUI検証中のpin変更を保存直前revisionで扱い明示revisionは維持する", async () => {
  const f = await fixture();
  const storage = new SessionExecutionStorageV6(f.dbPath);
  let validated!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { validated = resolve; });
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const service = new SessionExecutionService({
    storage,
    async validateTurn(_id, request) { validated(); await paused; return request; },
    async dispatchTurn() { throw new Error("busy Session must stay queued"); },
    cancelRunningTurn() {}, isSessionRunInFlight: () => true,
    createExecutionId: randomUUID, currentTimestamp: () => NOW, resolveIdempotencyExpiresAt: () => EXPIRES,
  });
  const facade = new MainSessionCommandFacade({
    getSession: (id) => f.storage.getSession(id), getSessionExecutionService: () => service,
    getProviderQuotaTelemetry: () => null, isProviderQuotaTelemetryStale: () => false,
  } as ConstructorParameters<typeof MainSessionCommandFacade>[0]);
  try {
    const stale = storage.getSessionContainerRevision("root");
    const send = facade.enqueueSessionTurn("root", { userMessage: "hello", clientRequestId: "gui-key" });
    await started;
    f.storage.setSessionPinned("root", true);
    resume();
    const result = await send;
    assert.equal(result.ok, true);
    assert.equal(storage.listSessionExecutions("root").length, 1);
    assert.equal(f.storage.getSession("root")?.isPinned, true);
    await assert.rejects(service.enqueue({ proof: proof("turn.enqueue"), sessionId: "root", expectedContainerRevision: stale, request: {}, idempotencyKey: "explicit", requestFingerprint: "explicit" }), { code: "SESSION_REVISION_CONFLICT" });
    assert.equal(storage.listSessionExecutions("root").length, 1);
  } finally {
    service.beginShutdown(); storage.close(); await f.close();
  }
});

for (const kind of ["file", "transcript"] as const) {
  // @test-value v2
  // kind = "regression"
  // claim = "期限内再送は同じ結果を返し、期限後の同一キー再利用は旧履歴を保持した別実行になる"
  // oracle = { type = "contract", ref = "review-P2-expired-saga-key" }
  // fault = "期限後の同一キー受付が失敗するか、新実行が過去の履歴を上書きする"
  // observable = "prepareのreplayとpending結果、保持event数、operation ID数、startup検証成功"
  // observation_boundary = "component-behavior"
  // scope = "file write and transcript export admission"
  // lifecycle = "permanent"
  // @end-test-value
  test("file write / transcript export: 期限後の同一キー再利用は旧履歴と衝突しない", async () => {
    const f = await fixture();
    const transcript = new SessionTranscriptStorageV6(f.dbPath);
    const db = new DatabaseSync(f.dbPath);
    const operationProof = proof(kind === "file" ? "session.files.write_text" : "transcript.export");
    const common = { proof: operationProof, idempotencyKey: "same-key", requestFingerprint: "same-input" };
    const input = { ...common, sessionId: "root", relativePath: "output.txt", tempName: ".output.tmp", createdAt: NOW, expiresAt: EXPIRES };
    const prepare = (createdAt: string) => kind === "file" ? f.storage.prepareSessionFileWrite({ ...input, createdAt }) : transcript.prepareExport({ ...input, createdAt });
    const table = kind === "file" ? "session_file_write_events_v6" : "session_transcript_export_events_v6";
    try {
      assert.equal(prepare(NOW).kind, "pending");
      const output = { sha256: "a".repeat(64), byteLength: 1, device: "1", inode: "2", targetPrecondition: { kind: "absent" as const } };
      const result = { file: { relativePath: "output.txt" } };
      if (kind === "file") {
        f.storage.recordPreparedSessionFileWrite({ ...common, prepared: output });
        f.storage.completeSessionFileWrite({ ...common, prepared: output, result, completedAt: NOW, expiresAt: EXPIRES });
      } else {
        const prepared = { outputSha256: output.sha256, byteLength: output.byteLength, outputDevice: output.device, outputInode: output.inode, targetPrecondition: output.targetPrecondition };
        transcript.recordPreparedOutput({ ...common, ...prepared });
        transcript.completeExport({ ...common, ...prepared, result, completedAt: NOW, expiresAt: EXPIRES });
      }
      const replay = prepare(NOW);
      assert.equal(replay.kind, "replay");
      if (replay.kind === "replay") assert.deepEqual(replay.result, result);
      const before = db.prepare(`SELECT * FROM ${table} ORDER BY revision`).all();
      assert.equal(prepare(EXPIRES).kind, "pending");
      const ids = db.prepare(`SELECT DISTINCT operation_id FROM ${table}`).all();
      assert.equal(ids.length, 2);
      assert.equal(db.prepare(`SELECT * FROM ${table}`).all().length, before.length + 1);
      assert.deepEqual(db.prepare(`SELECT * FROM ${table} WHERE operation_id = ? ORDER BY revision`).all(before[0]!.operation_id!), before);
      assert.doesNotThrow(() => ensureV6Schema(db));
    } finally {
      db.close(); transcript.close(); await f.close();
    }
  });
}
