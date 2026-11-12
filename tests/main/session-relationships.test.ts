import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { assertChildSessionRole } from "../../src-shared/session/session-role.js";
import { assertDirectChildSessionControl, assertDirectSessionSend, queryRelatedSessions, resolveRelatedSessions } from "../../src-electron/session/session-relationship-resolver.js";
import { projectSessionSummary } from "../../src-shared/session/session-state.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { DatabaseSync } from "node:sqlite";

// @test-value v2
// kind = "contract"
// claim = "Session探索は保存済みCharacterのID・名前・公開descriptionをMain/Auxiliaryで返し、公開紹介で検索できる"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md; docs/design/character-storage.md" }
// fault = "summary経路で公開紹介やAuxiliaryの名前が落ちるか、自己定義全文を公開する"
// observable = "再読したMain/Auxiliary summaryからのRelatedSession.characterと検索結果"
// observation_boundary = "public-boundary"
// scope = "session-character-discovery"
// lifecycle = "permanent"
// @end-test-value
it("保存snapshotの公開プロフィールをMainとAuxiliaryの探索へ渡す", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-peer-profile-"));
  const dbPath = path.join(directory, "app.db");
  const storage = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const snapshot = { characterId: "azki", name: "AZKi", description: "落ち着いて相談する同僚", iconFilePath: "", theme: { main: "#fff", sub: "#000" },
    definitionMarkdown: "private persona instructions", definitionSha256: "hash", definitionByteSize: 28, snapshotAt: "2026-11-12T00:00:00.000Z" };
  try {
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('azki', 'AZKi', ?, ?)").run(snapshot.snapshotAt, snapshot.snapshotAt);
    db.close();
    const session = storage.insertSession(buildNewSession({ id: "root", taskTitle: "Task", workspaceLabel: "Workspace", workspacePath: "C:/work", branch: "main",
      characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: snapshot.theme, characterRuntimeSnapshot: snapshot, approvalMode: "on-request" }));
    auxiliary.upsertAuxiliarySession({ id: "aux", parentSessionId: session.id, title: "Aux", runState: "idle", provider: "codex", catalogRevision: 1,
      model: session.model, reasoningEffort: session.reasoningEffort, approvalMode: session.approvalMode, codexSandboxMode: session.codexSandboxMode,
      codexSpeed: session.codexSpeed, codexReviewer: session.codexReviewer, customAgentName: "", threadId: "", composerDraft: "", messages: [],
      displayAfterMessageIndex: null, createdAt: snapshot.snapshotAt, updatedAt: snapshot.snapshotAt, characterId: "azki", characterRuntimeSnapshot: snapshot });
    const expected = { id: "azki", name: "AZKi", description: snapshot.description };
    const entries = resolveRelatedSessions(storage.listSessionSummaries(), auxiliary.listAuxiliarySessionSummaries([session.id]));
    assert.deepEqual(entries.map((entry) => entry.character), [expected, expected]);
    assert.deepEqual(resolveRelatedSessions([projectSessionSummary(session)], [])[0].character, expected);
    assert.equal(queryRelatedSessions(entries, entries[0], { searchText: "相談する同僚" }).total, 2);
    assert.equal(JSON.stringify(entries).includes(snapshot.definitionMarkdown), false);
  } finally { auxiliary.close(); storage.close(); await rm(directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "Crew探索は別枝と他Crewも列挙できるが、送信は直属親子、取消は直属親から子に限られる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/834" }
// fault = "同じRoleやCrewを直接親子の代わりに認可へ使う"
// observable = "関連一覧のID、送信・取消の許可と例外"
// observation_boundary = "component-behavior"
// scope = "saved-session-relationships"
// lifecycle = "permanent"
// @end-test-value
it("separates Crew discovery from direct-parent operations", () => {
  const root = buildNewSession({ id: "o", taskTitle: "Root", sessionRole: "overall-coordinator", workspaceLabel: "Workspace", workspacePath: "C:/work", branch: "", characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: "on-request" });
  const mains = [root,
    { ...root, id: "m1", sessionRole: "task-coordinator" as const, parentSessionId: "o", createdBySessionId: "o" },
    { ...root, id: "m2", sessionRole: "task-coordinator" as const, parentSessionId: "o", createdBySessionId: "o" },
    { ...root, id: "w1", sessionRole: "executor" as const, parentSessionId: "m1", createdBySessionId: "m1" },
    { ...root, id: "w2", sessionRole: "executor" as const, parentSessionId: "m2", createdBySessionId: "m2" },
    { ...root, id: "other", rootSessionId: "other" }];
  const entries = resolveRelatedSessions(mains, [{ ...root, id: "aux", parentSessionId: "m2", title: "User auxiliary", createdAt: "2026-11-07T00:00:00.000Z", displayAfterMessageIndex: null, runState: "idle" }]);
  const [o, m1, , w1, w2] = entries;
  assert.deepEqual(queryRelatedSessions(entries, w1).entries.map((entry) => entry.id), ["o", "m1", "m2", "w1", "w2", "aux"]);
  assert.equal(queryRelatedSessions(entries, w1, { allCrews: true }).total, 7);
  assert.equal(entries.at(-1)?.createdBySessionId, null);
  assert.equal(entries.at(-1)?.mainSessionId, "m2");
  assert.throws(() => assertDirectSessionSend(entries[2], entries.at(-1)!));
  assertDirectSessionSend(m1, w1);
  assertDirectSessionSend(w1, m1);
  assertDirectChildSessionControl(m1, w1);
  assert.throws(() => assertDirectSessionSend(o, w1));
  assert.throws(() => assertDirectSessionSend(w1, w2));
  assert.throws(() => assertDirectChildSessionControl(w1, m1));
  assertChildSessionRole("overall-coordinator", "executor");
  assertChildSessionRole("task-coordinator", "executor");
  assert.throws(() => assertChildSessionRole("executor", "executor"));
});

// @test-value v2
// kind = "invariant"
// claim = "保存関係は再openと古い全文保存で維持され、保存された親Roleに不適合な子作成は拒否される"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/834" }
// fault = "全文保存でRole変更を戻すか、自己申告だけで子作成経路を拡大する"
// observable = "再openしたSessionのRole・起点・親・作成元と不正作成の例外"
// observation_boundary = "component-behavior"
// scope = "saved-session-relationships"
// lifecycle = "permanent"
// @end-test-value
it("persists relationships without granting a full-save Role mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-relationships-"));
  const dbPath = path.join(directory, "sessions.db");
  let storage = new SessionStorageV6(dbPath);
  try {
    const input = buildNewSession({ id: "root", taskTitle: "Root", workspaceLabel: "Workspace", workspacePath: "C:/work", branch: "", characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: "on-request" });
    const root = storage.insertSession(input);
    storage.promoteSessionToOverallCoordinator(root.id, root.incarnationId!);
    storage.updateSession({ ...root, taskTitle: "Still the same conversation" });
    assert.equal(storage.getSession(root.id)?.sessionRole, "overall-coordinator");
    const child = storage.insertSession({ ...input, id: "child", sessionRole: "executor", rootSessionId: root.id, parentSessionId: root.id, createdBySessionId: root.id });
    assert.throws(() => storage.insertSession({ ...child, id: "grandchild", parentSessionId: child.id, createdBySessionId: child.id }));
    storage.close();
    storage = new SessionStorageV6(dbPath);
    assert.deepEqual([storage.getSession(child.id)?.rootSessionId, storage.getSession(child.id)?.parentSessionId, storage.getSession(child.id)?.createdBySessionId], [root.id, root.id, root.id]);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
