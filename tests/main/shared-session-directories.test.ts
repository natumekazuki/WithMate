import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizeAuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

function parentSession(id: string, workspacePath: string, directories: string[]) {
  return buildNewSession({
    id, taskTitle: id, workspaceLabel: "workspace", workspacePath, branch: "main",
    characterId: "mate", character: "Mate", characterIconPath: "",
    characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "untrusted",
    allowedAdditionalDirectories: directories,
  });
}

// @test-value v2
// kind = "contract"
// claim = "DirectoryはMainだけに保存され、Aux行を変更せず全Auxの実行contextが現在の親一覧を使用し、古いAux保存と再起動でも親の変更を維持する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#Additional Directory; docs/design/auxiliary-session.md#Context boundary" }
// fault = "AuxへDirectoryを重複保存する、古い実行snapshotの保存で親設定を戻す、別親の許可を混入する、または次turnが古い一覧を使用する"
// observable = "実DBのDirectory列配置、Aux保存行、Service実行context、CAS結果、再起動後の親設定と本文/draft/thread"
// observation_boundary = "public-boundary"
// scope = "V6 Main/Aux storageと実行contextのDirectory所有者"
// lifecycle = "permanent"
// impact = "取消済みのファイル権限の復活や別Sessionへの権限混入を防ぐ"
// distinction = "projectionやtypeだけでは実DBの二重保存と実行context解決を検証できない"
// @end-test-value
test("DirectoryはMainにだけ保存し全Auxの実行contextで参照する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-shared-directories-"));
  const dbPath = path.join(directory, "app.db");
  let main = new SessionStorageV6(dbPath);
  let auxiliary = new AuxiliarySessionStorage(dbPath);
  const roots = ["a-initial", "b-current", "c-other"].map((name) => path.join(directory, name));
  const service = new AuxiliarySessionService({
    getParentSession: (id) => main.getSession(id), getStorage: () => auxiliary,
    runProviderRuntimeOperationExclusive: async (operation) => await operation(),
    resolveSessionLaunchSelection: async () => { throw new Error("Creation is not part of this test."); },
    listActiveCharacters: () => [], createCharacterRuntimeSnapshot: () => null,
  });
  try {
    main.insertSession(parentSession("parent", path.join(directory, "workspace"), [roots[0]!]));
    main.insertSession(parentSession("other", path.join(directory, "other-workspace"), [roots[2]!]));
    const active = auxiliary.upsertAuxiliarySession(normalizeAuxiliarySession({
      id: "active", parentSessionId: "parent", threadId: "provider-thread", composerDraft: "unsent",
      messages: [{ role: "user", text: "question" }], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
    })!);
    auxiliary.upsertAuxiliarySession(normalizeAuxiliarySession({ id: "closed", parentSessionId: "parent", status: "closed" })!);
    auxiliary.upsertAuxiliarySession(normalizeAuxiliarySession({ id: "other-aux", parentSessionId: "other" })!);
    const captured = await service.getAuxiliaryRuntimeSession(active.id);
    assert.deepEqual(captured?.allowedAdditionalDirectories, [roots[0]]);
    const raw = new DatabaseSync(dbPath);
    try {
      const columns = (table: string) => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
      assert.ok(columns("sessions_v6").includes("allowed_additional_directories_json"));
      assert.ok(!columns("auxiliary_sessions").includes("allowed_additional_directories_json"));
      const before = raw.prepare("SELECT * FROM auxiliary_sessions ORDER BY id").all();
      main.updateSession({ ...main.getSession("parent")!, allowedAdditionalDirectories: [roots[1]!] });
      assert.deepEqual(raw.prepare("SELECT * FROM auxiliary_sessions ORDER BY id").all(), before);
    } finally { raw.close(); }
    assert.deepEqual(captured?.allowedAdditionalDirectories, [roots[0]]);
    for (const id of ["active", "closed"]) {
      assert.deepEqual((await service.getAuxiliaryRuntimeSession(id))?.allowedAdditionalDirectories, [roots[1]]);
    }
    const saved = auxiliary.updateAuxiliarySessionIfMatches({ expectedSession: active,
      session: { ...active, messages: [...active.messages, { role: "assistant", text: "answer" }] } });
    assert.ok(saved);
    assert.equal(saved.messages.at(-1)?.text, "answer");
    auxiliary.upsertAuxiliarySession(saved);
    auxiliary.upsertAuxiliarySession(normalizeAuxiliarySession({ id: "new", parentSessionId: "parent" })!);
    auxiliary.close();
    main.close();
    main = new SessionStorageV6(dbPath);
    auxiliary = new AuxiliarySessionStorage(dbPath);
    assert.deepEqual(main.getSession("parent")?.allowedAdditionalDirectories, [roots[1]]);
    for (const id of ["active", "closed", "new"]) {
      assert.deepEqual((await service.getAuxiliaryRuntimeSession(id))?.allowedAdditionalDirectories, [roots[1]]);
    }
    assert.deepEqual((await service.getAuxiliaryRuntimeSession("other-aux"))?.allowedAdditionalDirectories, [roots[2]]);
    const restored = auxiliary.getAuxiliarySession("active")!;
    assert.equal(restored.threadId, active.threadId);
    assert.equal(restored.composerDraft, active.composerDraft);
    assert.equal(restored.updatedAt, active.updatedAt);
    assert.equal(restored.messages.at(-1)?.text, "answer");
  } finally {
    auxiliary.close();
    main.close();
    await rm(directory, { recursive: true, force: true });
  }
});
