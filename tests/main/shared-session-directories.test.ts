import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizeAuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
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
// claim = "既存Mainとactive/closed AuxのDirectoryは親単位で統合され、Mainでの変更・staleなAux保存・再起動後も全Auxが現在の共通一覧を保持する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#Additional Directory; docs/design/auxiliary-session.md#Context boundary" }
// fault = "既存Auxの許可を失う、別親へ混入する、staleなAux保存を拒否するか削除済みDirectoryを復活させる、または移行で会話情報を変える"
// observable = "実DB再読込のMain/全AuxのDirectory、CAS保存結果、本文/draft/thread/時刻と再起動後の共通一覧"
// observation_boundary = "public-boundary"
// scope = "V6 Main/Aux storageの列形式・旧payload形式の移行と共通Directory保存"
// lifecycle = "permanent"
// impact = "保存済みアクセス対象の喪失や取消済み権限の復活、別Sessionへの権限混入を防ぐ"
// distinction = "独立storageやUI mockでは同一SQLite内の両owner更新、旧payload移行と再起動を通らない"
// @end-test-value
test("Mainと全AuxのDirectoryは移行・並行保存・再起動を通じて共通になる", async () => {
  for (const format of ["columns", "payload"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-shared-directories-"));
    const dbPath = path.join(directory, "app.db");
    let main = new SessionStorageV6(dbPath);
    let auxiliary = new AuxiliarySessionStorage(dbPath);
    const roots = ["a-main", "b-active", "c-closed", "d-other", "e-current"].map((name) => path.join(directory, name));
    try {
      main.insertSession(parentSession("parent", path.join(directory, "workspace"), [roots[0]!]));
      main.insertSession(parentSession("other", path.join(directory, "other-workspace"), [roots[3]!]));
      const originals = [
        normalizeAuxiliarySession({ id: "active", parentSessionId: "parent", allowedAdditionalDirectories: [roots[1]],
          threadId: "provider-thread", composerDraft: "unsent", messages: [{ role: "user", text: "question" }],
          createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" })!,
        normalizeAuxiliarySession({ id: "closed", parentSessionId: "parent", status: "closed", allowedAdditionalDirectories: [roots[2]],
          createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" })!,
        normalizeAuxiliarySession({ id: "other-aux", parentSessionId: "other", allowedAdditionalDirectories: [roots[3]] })!,
      ];
      for (const original of originals) auxiliary.upsertAuxiliarySession(original);
      const parentBefore = main.getSession("parent")!;
      const raw = new DatabaseSync(dbPath);
      try {
        if (format === "payload") raw.exec("ALTER TABLE auxiliary_sessions ADD COLUMN payload_json TEXT");
        for (const original of originals) {
          raw.prepare("UPDATE auxiliary_sessions SET allowed_additional_directories_json = ? WHERE id = ?")
            .run(JSON.stringify(original.allowedAdditionalDirectories), original.id);
          if (format === "payload") raw.prepare("UPDATE auxiliary_sessions SET payload_json = ? WHERE id = ?")
            .run(JSON.stringify(original), original.id);
        }
      } finally { raw.close(); }
      auxiliary.close();
      main.close();
      main = new SessionStorageV6(dbPath);
      auxiliary = new AuxiliarySessionStorage(dbPath);
      const union = roots.slice(0, 3);
      assert.deepEqual(main.getSession("parent"), { ...parentBefore, allowedAdditionalDirectories: union });
      for (const original of originals.slice(0, 2)) {
        const restored = auxiliary.getAuxiliarySession(original.id)!;
        assert.deepEqual(restored.allowedAdditionalDirectories, union);
        assert.equal(restored.updatedAt, original.updatedAt);
        assert.equal(restored.threadId, original.threadId);
        assert.equal(restored.composerDraft, original.composerDraft);
        assert.deepEqual(restored.messages, original.messages);
        assert.equal(restored.status, original.status);
      }
      const captured = auxiliary.getAuxiliarySession("active")!;
      main.updateSession({ ...main.getSession("parent")!, allowedAdditionalDirectories: [roots[4]!] });
      assert.deepEqual(captured.allowedAdditionalDirectories, union);
      for (const id of ["active", "closed"]) {
        assert.deepEqual(auxiliary.getAuxiliarySession(id)?.allowedAdditionalDirectories, [roots[4]]);
      }
      const saved = auxiliary.updateAuxiliarySessionIfMatches({ expectedSession: captured,
        session: { ...captured, messages: [...captured.messages, { role: "assistant", text: "answer" }] } });
      assert.ok(saved);
      assert.deepEqual(saved.allowedAdditionalDirectories, [roots[4]]);
      assert.equal(saved.messages.at(-1)?.text, "answer");
      assert.deepEqual(auxiliary.upsertAuxiliarySession({ ...saved, allowedAdditionalDirectories: union }).allowedAdditionalDirectories, [roots[4]]);
      assert.deepEqual(auxiliary.upsertAuxiliarySession(normalizeAuxiliarySession({ id: "new", parentSessionId: "parent",
        allowedAdditionalDirectories: [roots[0]] })!).allowedAdditionalDirectories, [roots[4]]);
      auxiliary.close();
      main.close();
      main = new SessionStorageV6(dbPath);
      auxiliary = new AuxiliarySessionStorage(dbPath);
      assert.deepEqual(main.getSession("parent")?.allowedAdditionalDirectories, [roots[4]]);
      for (const id of ["active", "closed", "new"]) {
        assert.deepEqual(auxiliary.getAuxiliarySession(id)?.allowedAdditionalDirectories, [roots[4]]);
      }
      assert.deepEqual(main.getSession("other")?.allowedAdditionalDirectories, [roots[3]]);
      assert.deepEqual(auxiliary.getAuxiliarySession("other-aux")?.allowedAdditionalDirectories, [roots[3]]);
    } finally {
      auxiliary.close();
      main.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Directory移行で不正な既存配列を検出した場合、他の親も含めて元の許可一覧を変更せず失敗する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#Additional Directory" }
// fault = "不正値を空配列へ救済して権限を失うか、先行した親だけ統合して失敗する"
// observable = "storage起動の例外と失敗後SQLiteの親・Aux両列"
// observation_boundary = "public-boundary"
// scope = "共有Directory起動時移行のatomic rollback"
// lifecycle = "permanent"
// impact = "破損データを成功扱いして利用者のアクセス設定を不可逆に変えない"
// distinction = "正常な移行・保存testでは途中失敗時のtransaction境界を検証できない"
// @end-test-value
test("共有Directoryの移行失敗は全親の変更をrollbackする", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-shared-directory-rollback-"));
  const dbPath = path.join(directory, "app.db");
  const main = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const roots = ["a", "b"].map((name) => path.join(directory, name));
  try {
    for (const id of ["a", "b"]) {
      main.insertSession(parentSession(id, path.join(directory, "workspace"), [roots[0]!]));
      auxiliary.upsertAuxiliarySession(normalizeAuxiliarySession({ id: `aux-${id}`, parentSessionId: id })!);
    }
  } finally { auxiliary.close(); main.close(); }
  const raw = new DatabaseSync(dbPath);
  try {
    raw.prepare("UPDATE auxiliary_sessions SET allowed_additional_directories_json = ? WHERE id = 'aux-a'").run(JSON.stringify([roots[1]]));
    raw.prepare("UPDATE auxiliary_sessions SET allowed_additional_directories_json = ? WHERE id = 'aux-b'").run("[42]");
    assert.throws(() => new AuxiliarySessionStorage(dbPath), /must be a string array/);
    assert.deepEqual((raw.prepare("SELECT allowed_additional_directories_json AS dirs FROM sessions_v6 ORDER BY id").all() as Array<{ dirs: string }>).map((row) => row.dirs),
      [JSON.stringify([roots[0]]), JSON.stringify([roots[0]])]);
    assert.equal((raw.prepare("SELECT allowed_additional_directories_json AS dirs FROM auxiliary_sessions WHERE id = 'aux-a'").get() as { dirs: string }).dirs,
      JSON.stringify([roots[1]]));
  } finally { raw.close(); await rm(directory, { recursive: true, force: true }); }
});
