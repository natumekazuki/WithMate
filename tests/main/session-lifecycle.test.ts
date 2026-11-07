import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, rm, stat, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { captureSessionLifecycleResource, cleanupSessionLifecycleResource, prepareSessionLifecycleFiles } from "../../src-electron/session/session-lifecycle-files.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { MainSessionCommandFacade } from "../../src-electron/app/main-session-command-facade.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionLifecycleResource } from "../../src-electron/session/session-lifecycle-operation.js";

function input(id: string) {
  return { id, taskTitle: "Task", workspaceLabel: "Workspace", workspacePath: "C:/work", branch: "", characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: "on-request" as const };
}

function lifecyclePersistence(storage: SessionStorageV6, catalog: ModelCatalogProvider) {
  let cached = storage.listSessions();
  const persistence = new SessionPersistenceService({
    getSessions: () => cached, setSessions: (next) => { cached = next; }, getSession: (id) => cached.find((item) => item.id === id) ?? null,
    getStoredSession: storage.getSession.bind(storage), getStoredSessionSummary: storage.getSessionSummary.bind(storage), isSessionRunInFlight: () => false,
    upsertStoredSession: (session, operation) => operation === "create" ? storage.insertSession(session) : storage.updateSession(session),
    replaceStoredSessions: (sessions) => { storage.replaceSessions(sessions); }, listStoredSessions: storage.listSessions.bind(storage), listStoredSessionSummaries: storage.listSessionSummaries.bind(storage),
    getSessionLifecycleOperation: storage.getSessionLifecycleOperation.bind(storage), listPendingSessionLifecycleOperations: storage.listPendingSessionLifecycleOperations.bind(storage),
    beginSessionLifecycleOperation: storage.beginSessionLifecycleOperation.bind(storage), prepareSessionLifecycleCreation: storage.prepareSessionLifecycleCreation.bind(storage), advanceSessionLifecycleOperation: storage.advanceSessionLifecycleOperation.bind(storage),
    deleteSessionCrewForLifecycle: storage.deleteSessionCrewForLifecycle.bind(storage),
    getAppSettings: createDefaultAppSettings, getModelCatalogSnapshot: () => ({ providers: [catalog] }),
    syncSessionDependencies: () => {}, clearSessionContextTelemetry: () => {}, clearSessionBackgroundActivities: () => {}, invalidateProviderSessionThread: () => {}, closeSessionWindow: () => {}, broadcastSessions: () => {},
  });
  return { persistence, cached: () => cached };
}

function lifecycleFacade(storage: SessionStorageV6, directory: string, harness: ReturnType<typeof lifecyclePersistence>, overrides: Partial<ConstructorParameters<typeof MainSessionCommandFacade>[0]> = {}) {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  return new MainSessionCommandFacade({
    getSessions: harness.cached, getSession: (id) => harness.cached().find((item) => item.id === id) ?? null,
    getStoredSessionSummaries: storage.listSessionSummaries.bind(storage), getSessionStorageIdentity: () => storage,
    runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
    resolveSessionLaunchSelection: async () => { throw new Error("The test does not use GUI launch defaults."); },
    getSessionPersistenceService: () => harness.persistence, getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null, isProviderQuotaTelemetryStale: () => false, refreshProviderQuotaTelemetry: async () => null,
    initializeCreatedSession: async () => {}, createSessionId: () => "reserved-child",
    createSessionFilesDirectory: async (id) => { const value = path.join(directory, id); await mkdir(value); return value; },
    resolveSessionFilesDirectory: (id) => path.join(directory, id),
    isSessionFilesWorkspace: () => false, dismissSessionTurnNotification: () => {}, validateWorkspaceDirectory: async () => ({ valid: true }),
    ...overrides,
  });
}

// @test-value v2
// kind = "invariant"
// claim = "作成要求のidentityと選択済みCharacterは再open・再試行でも変わらず、初期AuxがないMainは公開一覧へ現れない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "同じ要求を重複予約するか、保存途中のMainを作成成功として公開する"
// observable = "保存された操作のtargets/preparedSession、一覧ID、初期Auxなしの完了拒否と再open後一覧"
// observation_boundary = "component-behavior"
// scope = "Session lifecycle creation persistence"
// lifecycle = "permanent"
// @end-test-value
it("recovers the same prepared creation and publishes only the complete pair", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-"));
  const dbPath = path.join(directory, "app.db");
  let storage = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  try {
    storage.beginSessionLifecycleOperation({ operationId: "create-1", kind: "create", input: { title: "Task", requestId: "same" }, targets: [{ id: "root", rootSessionId: "root" }] });
    storage.prepareSessionLifecycleCreation("create-1", input("root"));
    storage.insertSession(buildNewSession(input("root")));
    assert.deepEqual(storage.listSessionSummaries(), []);
    assert.throws(() => storage.advanceSessionLifecycleOperation("create-1", "complete"));
    storage.close();
    storage = new SessionStorageV6(dbPath);
    const operation = storage.beginSessionLifecycleOperation({ operationId: "create-1", kind: "create", input: { requestId: "same", title: "Task" }, targets: [{ id: "another" }] });
    assert.equal(operation.targets[0].id, "root");
    assert.equal(storage.prepareSessionLifecycleCreation("create-1", { ...input("root"), characterId: "replacement" }).preparedSession?.characterId, "azki");
    assert.throws(() => storage.beginSessionLifecycleOperation({ operationId: "create-1", kind: "create", input: { requestId: "same", title: "Changed" }, targets: [{ id: "root" }] }));
    const root = storage.getSession("root")!;
    auxiliary.upsertAuxiliarySession({ ...root, id: "aux", parentSessionId: root.id, title: "Aux", createdAt: root.updatedAt, runState: "idle", composerDraft: "draft", displayAfterMessageIndex: null, creationContext: { generationId: "test", parentIncarnationId: root.incarnationId! } });
    storage.advanceSessionLifecycleOperation("create-1", "complete");
    assert.deepEqual(storage.listSessionSummaries().map((item) => item.id), ["root"]);
    assert.equal(auxiliary.getAuxiliarySession("aux")?.composerDraft, "draft");
  } finally {
    auxiliary.close(); storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Crew削除は全Mainを一括適用し、実行中の子を保護し、DB適用後のFiles cleanupを同じ操作から再開できる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "起点だけ削除する、実行中の子を巻き込む、またはDB削除後にcleanup対象を失う"
// observable = "削除拒否後のMain件数、保存されたapplied状態、元folderの存在とcleanup完了状態"
// observation_boundary = "component-behavior"
// scope = "Crew atomic deletion and owned Files recovery"
// lifecycle = "permanent"
// @end-test-value
it("deletes a whole idle Crew and resumes only its fixed owned Files cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-delete-lifecycle-"));
  const storage = new SessionStorageV6(path.join(directory, "app.db"));
  const owned = path.join(directory, "owned");
  await mkdir(owned);
  try {
    const root = storage.insertSession({ ...buildNewSession(input("root")), sessionRole: "overall-coordinator" });
    const child = storage.insertSession({ ...buildNewSession(input("child")), sessionRole: "executor", rootSessionId: root.id, parentSessionId: root.id, createdBySessionId: root.id, status: "running", runState: "running" });
    assert.throws(() => storage.deleteSession(root.id));
    assert.throws(() => storage.deleteSessions([root.id, child.id]));
    assert.equal(storage.listSessionSummaries().length, 2);
    storage.updateSession({ ...child, status: "idle", runState: "idle" });
    const resource = await captureSessionLifecycleResource(owned);
    storage.beginSessionLifecycleOperation({ operationId: "delete-1", kind: "delete", input: { root: root.id }, targets: [root, child].map((item) => ({ id: item.id, incarnationId: item.incarnationId })), resources: [resource] });
    const operation = storage.deleteSessionCrewForLifecycle("delete-1");
    assert.equal(operation.phase, "applied");
    assert.deepEqual(storage.beginSessionLifecycleOperation({ operationId: "delete-1", kind: "delete", input: { root: root.id },
      targets: [{ id: "replacement" }], resources: [] }), operation);
    assert.equal(storage.getSession(root.id), null);
    assert.equal(storage.getSession(child.id), null);
    await assert.rejects(cleanupSessionLifecycleResource({ ...resource, inode: (BigInt(resource.inode) + 1n).toString() }), /identity changed/);
    assert.equal((await stat(owned)).isDirectory(), true);
    const cleaned = await cleanupSessionLifecycleResource(resource);
    storage.advanceSessionLifecycleOperation(operation.operationId, "complete", [cleaned]);
    assert.equal(storage.getSessionLifecycleOperation(operation.operationId)?.phase, "complete");
    assert.equal(storage.deleteSessionCrewForLifecycle(operation.operationId).phase, "complete");
  } finally {
    storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "DB未適用のCrew削除拒否後は、子追加を含む現在のCrew全体と所有Filesを次の明示削除で削除でき、別CrewのデータとFilesを保持する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#crewの作成削除" }
// fault = "拒否時のtargetsやFilesを再利用して再削除を拒否し続けるか、新しい子のFilesを残すか、別Crewを削除する"
// observable = "拒否後と回復後の保存Main一覧、Files本文、再削除完了後の操作targetsとresourcesとfolder不存在"
// observation_boundary = "component-behavior"
// scope = "Crew explicit deletion retry through facade, persistence, real SQLite and isolated Files"
// lifecycle = "permanent"
// impact = "通常のCrew削除が拒否から回復できなくなるか、対象外データを失う"
// distinction = "型検査やstorage単体testではfacadeによる旧操作再利用と所有Files再収集を通らないため、小さい隔離Crewを実DBで削除する"
// @end-test-value
it("reprepares a rejected Crew deletion for the current children and owned Files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-delete-retry-"));
  const storage = new SessionStorageV6(path.join(directory, "app.db"));
  const catalog: ModelCatalogProvider = { id: "codex", label: "Codex", defaultModelId: "model", defaultReasoningEffort: "high", models: [{ id: "model", label: "Model", reasoningEfforts: ["high"] }] };
  try {
    const root = storage.insertSession({ ...buildNewSession(input("root")), sessionRole: "overall-coordinator" });
    const child = storage.insertSession({ ...buildNewSession(input("child")), sessionRole: "executor", rootSessionId: root.id, parentSessionId: root.id, createdBySessionId: root.id, status: "running", runState: "running" });
    const other = storage.insertSession(buildNewSession(input("other")));
    const crewFiles = path.join(directory, "crew-files");
    for (const folder of [path.join(directory, root.id), path.join(directory, child.id), path.join(directory, other.id), crewFiles]) {
      await mkdir(folder);
      await writeFile(path.join(folder, "content.txt"), path.basename(folder));
    }
    const makeFacade = () => lifecycleFacade(storage, directory, lifecyclePersistence(storage, catalog), { resolveCrewFilesDirectory: () => crewFiles });
    await assert.rejects(makeFacade().deleteSession(root.id));
    const pending = storage.listPendingSessionLifecycleOperations()[0];
    assert.equal(pending.phase, "preparing");
    assert.deepEqual(new Set(pending.targets.map((target) => target.id)), new Set([root.id, child.id]));
    assert.equal(storage.listSessionSummaries().length, 3);
    for (const resource of pending.resources) assert.equal(await readFile(path.join(resource.path, "content.txt"), "utf8"), path.basename(resource.path));

    storage.updateSession({ ...child, status: "idle", runState: "idle" });
    const added = storage.insertSession({ ...buildNewSession(input("added")), sessionRole: "executor", rootSessionId: root.id, parentSessionId: root.id, createdBySessionId: root.id });
    await mkdir(path.join(directory, added.id));
    await writeFile(path.join(directory, added.id, "content.txt"), "added");
    await makeFacade().recoverPendingSessionLifecycleOperations();
    assert.equal(storage.listSessionSummaries().length, 4);
    assert.equal(await readFile(path.join(directory, added.id, "content.txt"), "utf8"), "added");

    await makeFacade().deleteSession(root.id);
    assert.deepEqual(storage.listSessionSummaries().map((session) => session.id), [other.id]);
    const complete = storage.getSessionLifecycleOperation(pending.operationId)!;
    assert.equal(complete.phase, "complete");
    assert.deepEqual(new Set(complete.targets.map((target) => target.id)), new Set([root.id, child.id, added.id]));
    assert.deepEqual(new Set(complete.resources.map((resource) => resource.path)), new Set([root.id, child.id, added.id].map((id) => path.join(directory, id)).concat(crewFiles)));
    for (const resource of complete.resources) {
      assert.equal(resource.cleaned, true);
      await assert.rejects(stat(resource.path), { code: "ENOENT" });
    }
    assert.equal(await readFile(path.join(directory, other.id, "content.txt"), "utf8"), other.id);
  } finally {
    storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同一子作成要求のFiles失敗・初期Aux失敗後の再試行はCharacterとidentityを再利用し、親指定設定を保存して完成後だけ公開する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "途中失敗の再試行で再抽選・重複Sessionを作成するか、親指定設定をGUI defaultsで置換する"
// observable = "実DBの子Session件数・Character・実行設定、初期Aux、公開一覧、抽選snapshot作成回数"
// observation_boundary = "component-behavior"
// scope = "common child Session application with real SQLite and Files"
// lifecycle = "permanent"
// @end-test-value
it("retries child creation without redrawing its Character or replacing parent execution choices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-create-child-"));
  const storage = new SessionStorageV6(path.join(directory, "app.db"));
  const auxiliary = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const setup = new DatabaseSync(path.join(directory, "app.db"));
  for (const id of ["azki", "sora"]) setup.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES(?,?,'now','now')").run(id, id);
  setup.close();
  const root = storage.insertSession({ ...buildNewSession(input("root")), sessionRole: "overall-coordinator" });
  storage.insertSession({ ...buildNewSession(input("other-crew")), characterId: "sora" });
  let cached = storage.listSessions();
  let snapshotCount = 0;
  let filesFail = true;
  let auxiliaryFail = true;
  let issued = 0;
  const openedChildren: string[] = [];
  const coordinator = new ProviderRuntimeOperationCoordinator();
  const catalog = { id: "codex", label: "Codex", defaultModelId: "model", defaultReasoningEffort: "high" as const, models: [{ id: "model", label: "Model", reasoningEfforts: ["high" as const] }] };
  const persistence = new SessionPersistenceService({
    getSessions: () => cached, setSessions: (next) => { cached = next; }, getSession: (id) => cached.find((item) => item.id === id) ?? null,
    getStoredSession: storage.getSession.bind(storage), isSessionRunInFlight: () => false,
    upsertStoredSession: (session, operation) => operation === "create" ? storage.insertSession(session) : storage.updateSession(session),
    replaceStoredSessions: (sessions) => { storage.replaceSessions(sessions); }, listStoredSessions: storage.listSessions.bind(storage), listStoredSessionSummaries: storage.listSessionSummaries.bind(storage),
    getSessionLifecycleOperation: storage.getSessionLifecycleOperation.bind(storage), listPendingSessionLifecycleOperations: storage.listPendingSessionLifecycleOperations.bind(storage),
    beginSessionLifecycleOperation: storage.beginSessionLifecycleOperation.bind(storage), prepareSessionLifecycleCreation: storage.prepareSessionLifecycleCreation.bind(storage), advanceSessionLifecycleOperation: storage.advanceSessionLifecycleOperation.bind(storage),
    getAppSettings: createDefaultAppSettings, getModelCatalogSnapshot: () => ({ providers: [catalog] }),
    syncSessionDependencies: () => {}, clearSessionContextTelemetry: () => {}, clearSessionBackgroundActivities: () => {}, invalidateProviderSessionThread: () => {}, closeSessionWindow: () => {}, broadcastSessions: () => {},
  });
  const facade = new MainSessionCommandFacade({
    getSessions: () => cached, getSession: (id) => cached.find((item) => item.id === id) ?? null, getStoredSessionSummaries: storage.listSessionSummaries.bind(storage),
    getSessionStorageIdentity: () => storage, runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
    resolveSessionLaunchSelection: async () => { throw new Error("Child creation must not read GUI launch defaults."); },
    getSessionPersistenceService: () => persistence, getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null, isProviderQuotaTelemetryStale: () => false, refreshProviderQuotaTelemetry: async () => null,
    initializeCreatedSession: async (session) => {
      if (auxiliaryFail) { auxiliaryFail = false; throw new Error("initial Auxiliary failed"); }
      auxiliary.upsertAuxiliarySession({ ...session, id: `${session.id}-aux`, parentSessionId: session.id, title: "Aux", runState: "idle", createdAt: session.updatedAt, composerDraft: "", displayAfterMessageIndex: null, creationContext: { generationId: "test", parentIncarnationId: session.incarnationId! } });
    },
    createSessionId: () => `child-${++issued}`,
    createSessionFilesDirectory: async (id) => { const value = path.join(directory, id); await mkdir(value); return value; },
    resolveSessionFilesDirectory: (id) => path.join(directory, id),
    prepareSessionLifecycleFiles: async (input) => { if (filesFail) { filesFail = false; throw new Error("Files failed"); } return prepareSessionLifecycleFiles(input); },
    isSessionFilesWorkspace: () => false, dismissSessionTurnNotification: () => {}, validateWorkspaceDirectory: async () => ({ valid: true }),
    listActiveCharacters: async () => ["azki", "sora"].map((id) => ({ id, name: id, description: "", iconFilePath: "", theme: { main: "#fff", sub: "#000" }, state: "active", createdAt: "now", updatedAt: "now", archivedAt: null })),
    createCharacterRuntimeSnapshot: async (id) => { snapshotCount += 1; return { characterId: id, name: id, description: "", iconFilePath: "", theme: { main: "#fff", sub: "#000" }, definitionMarkdown: "# Character\nCharacter", definitionSha256: "snapshot", definitionByteSize: 21, snapshotAt: "2026-11-07T00:00:00Z" }; },
    randomCharacter: () => 0,
    openCreatedChildSession: (session) => { openedChildren.push(session.id); },
  });
  const request = { requestId: "same-request", role: "executor" as const, provider: "codex", model: "model", reasoningEffort: "high" as const, approvalMode: "on-request" as const, codexSandboxMode: "read-only" as const, workspacePath: "C:/prepared-worktree", title: "Child" };
  try {
    const actor = { id: root.id, incarnationId: root.incarnationId! };
    await assert.rejects(facade.createChildSession(actor, request, () => {}), /Files failed/);
    assert.equal(storage.listPendingSessionLifecycleOperations()[0].preparedSession?.characterId, "sora");
    await assert.rejects(facade.createChildSession(actor, request, () => {}), /initial Auxiliary failed/);
    assert.equal(storage.listSessionSummaries().some((item) => item.parentSessionId === root.id), false);
    const child = await facade.createChildSession(actor, request, () => {});
    assert.equal(child.characterId, "sora");
    assert.equal(snapshotCount, 1);
    assert.equal(issued, 1);
    assert.deepEqual([child.provider, child.model, child.reasoningEffort, child.approvalMode, child.codexSandboxMode, child.workspacePath], ["codex", "model", "high", "on-request", "read-only", request.workspacePath]);
    assert.equal((await facade.createChildSession(actor, request, () => {})).id, child.id);
    assert.deepEqual(openedChildren, [child.id]);
    assert.equal(storage.listSessionSummaries().filter((item) => item.parentSessionId === root.id).length, 1);
    await assert.rejects(facade.createChildSession(actor, { ...request, title: "Different" }, () => {}), /different input/);
  } finally {
    auxiliary.close(); storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "期限削除はCrew内Auxの新しい活動を保護し、Coordinationの現在owner種別を照合し、候補抽出後の活動更新も削除transactionで保護する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "古いMainだけでCrewを期限対象にする、別Crew同名Auxの相談を誤判定する、または候補抽出後の新しい活動を削除する"
// observable = "期限候補ID、Coordination blocker IDとallowed、削除拒否後のMain行"
// observation_boundary = "component-behavior"
// scope = "Crew expiry and Coordination deletion guards"
// lifecycle = "permanent"
// @end-test-value
it("guards expiry and unresolved Coordination by the actual Crew conversation identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-crew-guards-"));
  const dbPath = path.join(directory, "app.db");
  const storage = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const db = new DatabaseSync(dbPath);
  const old = "2026-01-01T00:00:00.000Z";
  const recent = "2026-11-01T00:00:00.000Z";
  const cutoff = { cutoffDate: "2026-07-01", cutoffIso: "2026-07-01T00:00:00.000Z", cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z") };
  try {
    const root = storage.insertSession({ ...buildNewSession(input("root")), sessionRole: "overall-coordinator", updatedAt: old });
    const child = storage.insertSession({ ...buildNewSession(input("shared-id")), sessionRole: "executor", rootSessionId: root.id, parentSessionId: root.id, createdBySessionId: root.id, updatedAt: old });
    const other = storage.insertSession({ ...buildNewSession(input("other")), updatedAt: old });
    for (const [id, parent, updatedAt] of [["recent-aux", root, recent], [child.id, other, old]] as const) {
      auxiliary.upsertAuxiliarySession({ ...parent, id, parentSessionId: parent.id, title: "Aux", createdAt: old, updatedAt, runState: "idle", composerDraft: "", displayAfterMessageIndex: null });
    }
    assert.deepEqual(storage.listSessionIdsLastActiveBefore(cutoff), [other.id]);
    db.prepare("UPDATE auxiliary_sessions SET updated_at = ? WHERE id = 'recent-aux'").run(old);
    db.prepare("UPDATE auxiliary_session_drafts SET updated_at = ? WHERE auxiliary_session_id = 'recent-aux'").run(old);
    assert.deepEqual(new Set(storage.listSessionIdsLastActiveBefore(cutoff)), new Set([root.id, other.id]));
    db.prepare(`INSERT INTO coordination_records_v7(id,crew_root_session_id,initiator_session_id,initiator_kind,initiator_incarnation_id,respondent_kind,state,payload_json)
      VALUES('foreign-aux',?,'shared-id','auxiliary',?,'user','open','{}')`).run(other.id, old);
    assert.equal(storage.getCrewDeletionStatus(root.id, root.incarnationId!).allowed, true);
    db.prepare(`INSERT INTO coordination_records_v7(id,crew_root_session_id,initiator_session_id,initiator_kind,initiator_incarnation_id,respondent_session_id,respondent_kind,state,payload_json)
      VALUES('needs-reply',?,?,'main',?,'shared-id','main','open','{}')`).run(other.id, other.id, other.incarnationId!);
    assert.deepEqual(storage.getCrewDeletionStatus(root.id, root.incarnationId!).blockers.map((item) => item.id), ["needs-reply"]);
    assert.throws(() => storage.deleteSessions([root.id, child.id]));
    db.prepare("UPDATE coordination_records_v7 SET state='resolved' WHERE id='needs-reply'").run();
    assert.equal(storage.getCrewDeletionStatus(root.id, root.incarnationId!).allowed, true);
    storage.beginSessionLifecycleOperation({ operationId: "expired-root", kind: "delete", input: { cutoffIso: cutoff.cutoffIso }, targets: [root, child].map((item) => ({ id: item.id, incarnationId: item.incarnationId })) });
    storage.updateSession({ ...child, updatedAt: recent });
    assert.throws(() => storage.deleteSessionCrewForLifecycle("expired-root"), /activity cutoff/);
    assert.notEqual(storage.getSession(root.id), null);
    assert.notEqual(storage.getSession(child.id), null);
  } finally {
    db.close(); auxiliary.close(); storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Crew Files削除と適用済みcleanupの再試行は、非公開Mainと未保存の予約済みWorkspaceを保護する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "公開一覧に出ない作成途中SessionのWorkspaceを所有Filesとして再帰削除する"
// observable = "公開一覧の非公開維持、削除対象Mainの不在、Workspace内file本文、再cleanup拒否とapplied状態"
// observation_boundary = "component-behavior"
// scope = "Crew Files deletion with pending saved and prepared Session workspaces"
// lifecycle = "permanent"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
it("protects unpublished saved and reserved Workspaces before deletion and cleanup recovery", async () => {
  for (const stage of ["before-delete", "after-apply", "before-prepare"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-pending-workspace-"));
    const storage = new SessionStorageV6(path.join(directory, "app.db"));
    const folder = path.join(directory, "deleting-root");
    const workspace = path.join(folder, "project");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "work.txt"), "keep pending work", "utf8");
    try {
      const root = storage.insertSession(buildNewSession(input("deleting-root")));
      const parent = storage.insertSession({ ...buildNewSession(input("other-crew")), sessionRole: "overall-coordinator" });
      const catalog: ModelCatalogProvider = { id: "codex", label: "Codex", defaultModelId: "model", defaultReasoningEffort: "high", models: [{ id: "model", label: "Model", reasoningEfforts: ["high"] }] };
      const harness = lifecyclePersistence(storage, catalog);
      const facade = lifecycleFacade(storage, directory, harness);
      if (stage !== "before-delete") {
        storage.beginSessionLifecycleOperation({ operationId: "cleanup-after-delete", kind: "delete", input: { sessionId: root.id },
          targets: [{ id: root.id, incarnationId: root.incarnationId }], resources: [await captureSessionLifecycleResource(folder)] });
        storage.deleteSessionCrewForLifecycle("cleanup-after-delete");
      }
      const prepared = { ...input("pending-child"), workspacePath: workspace, sessionRole: "executor" as const, rootSessionId: parent.id, parentSessionId: parent.id, createdBySessionId: parent.id };
      storage.beginSessionLifecycleOperation({ operationId: "pending-create", kind: "create",
        input: { requestId: "pending", role: "executor", provider: "codex", model: "model", reasoningEffort: "high", approvalMode: "on-request", codexSandboxMode: "read-only", workspacePath: workspace },
        targets: [{ id: prepared.id, rootSessionId: parent.id, parentSessionId: parent.id, parentIncarnationId: parent.incarnationId }] });
      if (stage === "before-delete") storage.insertSession(buildNewSession(prepared));
      else if (stage === "after-apply") storage.prepareSessionLifecycleCreation("pending-create", prepared);
      assert.equal(storage.listSessionSummaries().some((session) => session.id === prepared.id), false);
      if (stage === "before-delete") await facade.deleteSession(root.id);
      else {
        await assert.rejects(facade.deleteSession(root.id), /overlaps a current Workspace/);
        assert.equal(storage.getSessionLifecycleOperation("cleanup-after-delete")?.phase, "applied");
      }
      assert.equal(storage.getSession(root.id), null);
      assert.equal(await readFile(path.join(workspace, "work.txt"), "utf8"), "keep pending work");
      assert.equal(storage.listSessionSummaries().some((session) => session.id === prepared.id), false);
    } finally {
      storage.close(); await rm(directory, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "未保存の子作成再試行は現在のModelとDepth対応を再検証し、予約済みidentityとCharacterを保持して、完成済み再照会には再検証を課さない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "初回Files失敗後にcatalogから消えたModelや非対応Depthで子Sessionを新規保存する"
// observable = "拒否理由、未保存Main、同じprepared Session・snapshot、完成後の同identity再照会"
// observation_boundary = "component-behavior"
// scope = "pending child creation retry execution-setting validation"
// lifecycle = "permanent"
// @end-test-value
it("revalidates pending child execution support without redrawing its prepared Character", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-child-revalidation-"));
  const dbPath = path.join(directory, "app.db");
  const storage = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  try {
    const setup = new DatabaseSync(dbPath);
    setup.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES('azki','AZKi','now','now')").run();
    setup.close();
    const parent = storage.insertSession({ ...buildNewSession(input("parent")), sessionRole: "overall-coordinator" });
    const catalog: ModelCatalogProvider = { id: "codex", label: "Codex", defaultModelId: "model", defaultReasoningEffort: "high", models: [{ id: "model", label: "Model", reasoningEfforts: ["high"] }] };
    const harness = lifecyclePersistence(storage, catalog);
    let filesFail = true;
    let snapshots = 0;
    const facade = lifecycleFacade(storage, directory, harness, {
      prepareSessionLifecycleFiles: async (input) => { if (filesFail) { filesFail = false; throw new Error("Files failed"); } return prepareSessionLifecycleFiles(input); },
      listActiveCharacters: async () => [{ id: "azki", name: "AZKi", description: "", iconFilePath: "", theme: { main: "#fff", sub: "#000" }, state: "active", createdAt: "now", updatedAt: "now", archivedAt: null }],
      createCharacterRuntimeSnapshot: async (id) => { snapshots += 1; return { characterId: id, name: id, description: "", iconFilePath: "", theme: { main: "#fff", sub: "#000" }, definitionMarkdown: "# Character", definitionSha256: "snapshot", definitionByteSize: 11, snapshotAt: "now" }; },
      initializeCreatedSession: async (session) => { auxiliary.upsertAuxiliarySession({ ...session, id: `${session.id}-aux`, parentSessionId: session.id, title: "Aux", runState: "idle", createdAt: session.updatedAt, composerDraft: "", displayAfterMessageIndex: null, creationContext: { generationId: "test", parentIncarnationId: session.incarnationId! } }); },
    });
    const actor = { id: parent.id, incarnationId: parent.incarnationId! };
    const request = { requestId: "same", role: "executor" as const, provider: "codex", model: "model", reasoningEffort: "high" as const, approvalMode: "on-request" as const, codexSandboxMode: "read-only" as const, workspacePath: "C:/prepared-worktree" };
    await assert.rejects(facade.createChildSession(actor, request, () => {}), /Files failed/);
    const prepared = storage.listPendingSessionLifecycleOperations()[0].preparedSession!;
    catalog.models = [];
    await assert.rejects(facade.createChildSession(actor, request, () => {}), /not in the discovered model list/);
    catalog.models = [{ id: "model", label: "Model", reasoningEfforts: ["low"] }];
    await assert.rejects(facade.createChildSession(actor, request, () => {}), /depth is not supported/);
    assert.equal(storage.getSession(prepared.id!), null);
    assert.deepEqual(storage.listPendingSessionLifecycleOperations()[0].preparedSession, prepared);
    assert.equal(snapshots, 1);
    catalog.models = [{ id: "model", label: "Model", reasoningEfforts: ["high"] }];
    const child = await facade.createChildSession(actor, request, () => {});
    assert.equal(child.id, prepared.id);
    catalog.models = [];
    assert.equal((await facade.createChildSession(actor, request, () => {})).incarnationId, child.incarnationId);
    assert.equal(snapshots, 1);
  } finally {
    auxiliary.close(); storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "GUIとAgent子の同一作成要求はstaging記録前・記録後publish前・publish後DB前の中断から固定final pathとidentityへ収束する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "mkdir中断をEEXISTとして永久に止める、記録済みdirectoryを再確保する、または同要求から重複Sessionを作る"
// observable = "再open後receipt、staging/finalのdev/ino、Main/Aux件数、未記録empty staging、公開された固定Session ID"
// observation_boundary = "component-behavior"
// scope = "GUI and child lifecycle crash recovery through real SQLite and native no-replace filesystem publication"
// lifecycle = "permanent"
// impact = "途中失敗した作成の重複・所有不明directoryの削除を防ぎ、同じ要求を再開可能にする"
// distinction = "mock Filesや完了後retryだけでは実directory publishとDB保存の中断順序を検証できない"
// @end-test-value
it("converges GUI and child creation across each staging publication crash boundary", async () => {
  for (const mode of ["gui", "child"] as const) {
    for (const boundary of ["before-receipt", "before-publish", "before-db"] as const) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-publication-recovery-"));
      const dbPath = path.join(directory, "app.db");
      let storage = new SessionStorageV6(dbPath);
      const auxiliary = new AuxiliarySessionStorage(dbPath);
      try {
        const setup = new DatabaseSync(dbPath);
        setup.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES('azki','AZKi','now','now')").run();
        setup.close();
        const parent = mode === "child" ? storage.insertSession({ ...buildNewSession(input("parent")), sessionRole: "overall-coordinator" }) : null;
        const catalog: ModelCatalogProvider = { id: "codex", label: "Codex", defaultModelId: "model", defaultReasoningEffort: "high", models: [{ id: "model", label: "Model", reasoningEfforts: ["high"] }] };
        let crashed = false;
        let firstResource: SessionLifecycleResource | undefined;
        let issued = 0;
        let snapshots = 0;
        const makeFacade = () => lifecycleFacade(storage, directory, lifecyclePersistence(storage, catalog), {
          createSessionId: () => `reserved-${++issued}`,
          resolveSessionLaunchSelection: async () => ({ provider: "codex", model: "model", reasoningEffort: "high", approvalMode: "on-request", codexSandboxMode: "read-only", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" }),
          prepareSessionLifecycleFiles: async (config) => {
            if (crashed) return prepareSessionLifecycleFiles(config);
            crashed = true;
            const finalPath = await prepareSessionLifecycleFiles({ ...config, persistResource: async (resource) => {
              firstResource = resource;
              if (boundary === "before-receipt") throw new Error("simulated crash before receipt");
              await config.persistResource(resource);
              if (boundary === "before-publish") throw new Error("simulated crash before publish");
            } });
            assert.equal(finalPath, firstResource?.path);
            throw new Error("simulated crash before DB");
          },
          listActiveCharacters: async () => [{ id: "azki", name: "AZKi", description: "", iconFilePath: "", theme: { main: "#fff", sub: "#000" }, state: "active", createdAt: "now", updatedAt: "now", archivedAt: null }],
          createCharacterRuntimeSnapshot: async (id) => { snapshots += 1; return { characterId: id, name: id, description: "", iconFilePath: "", theme: { main: "#fff", sub: "#000" }, definitionMarkdown: "# Character", definitionSha256: "snapshot", definitionByteSize: 11, snapshotAt: "now" }; },
          initializeCreatedSession: async (session) => { auxiliary.upsertAuxiliarySession({ ...session, id: `${session.id}-aux`, parentSessionId: session.id, title: "Aux", runState: "idle", createdAt: session.updatedAt, composerDraft: "", displayAfterMessageIndex: null, creationContext: { generationId: "test", parentIncarnationId: session.incarnationId! } }); },
        });
        const guiRequest = { provider: "codex", taskTitle: "Root", characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, workspace: { kind: "session-folder" as const }, clientRequestId: `gui-${boundary}` };
        const childRequest = { requestId: `child-${boundary}`, role: "executor" as const, provider: "codex", model: "model", reasoningEffort: "high" as const, approvalMode: "on-request" as const, codexSandboxMode: "read-only" as const, workspacePath: "C:/prepared-worktree" };
        const invoke = (facade: MainSessionCommandFacade) => mode === "gui" ? facade.createSessionFromRequest(guiRequest)
          : facade.createChildSession({ id: parent!.id, incarnationId: parent!.incarnationId! }, childRequest, () => {});
        await assert.rejects(invoke(makeFacade()), /simulated crash/);
        const pending = storage.listPendingSessionLifecycleOperations()[0];
        const target = pending.targets[0].id;
        assert.equal(storage.getSession(target), null);
        assert.ok(firstResource?.stagingPath);
        if (boundary === "before-receipt") {
          assert.equal(pending.resources.length, 0);
          assert.deepEqual(await readdir(firstResource.stagingPath), []);
        } else {
          assert.equal(pending.resources[0].stagingPath, firstResource.stagingPath);
        }
        storage.close();
        storage = new SessionStorageV6(dbPath);
        const recovered = await invoke(makeFacade());
        assert.equal(recovered.id, target);
        const complete = storage.getSessionLifecycleOperation(pending.operationId)!;
        assert.equal(complete.phase, "complete");
        assert.equal(complete.resources[0].path, firstResource.path);
        const actual = await captureSessionLifecycleResource(complete.resources[0].path);
        assert.deepEqual([actual.device, actual.inode], [complete.resources[0].device, complete.resources[0].inode]);
        if (boundary !== "before-receipt") assert.equal(actual.inode, firstResource.inode);
        else {
          assert.notEqual(complete.resources[0].stagingPath, firstResource.stagingPath);
          assert.deepEqual(await readdir(firstResource.stagingPath), []);
        }
        assert.equal(auxiliary.listAuxiliarySessionSummaries([target]).length, 1);
        assert.equal(storage.listSessionSummaries().filter((session) => session.id === target).length, 1);
        assert.equal((await invoke(makeFacade())).incarnationId, recovered.incarnationId);
        if (mode === "child") assert.equal(snapshots, 1);
      } finally {
        auxiliary.close(); storage.close(); await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
