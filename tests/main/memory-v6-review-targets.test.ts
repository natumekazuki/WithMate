import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { MemoryV6WorkerClient } from "../../src-electron/memory/memory-v6-worker-client.js";
import { MemoryV6ReviewService } from "../../src-electron/memory/memory-v6-review-service.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory/memory-v6-schema.js";

async function withReviewWorker(runner: (input: {
  service: MemoryV6ReviewService;
  worker: MemoryV6WorkerClient;
  dbPath: string;
  directory: string;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "withmate-review-targets-"));
  let worker: MemoryV6WorkerClient | undefined;
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        INSERT INTO characters (id, name, icon_file_path, state, created_at, updated_at) VALUES
          ('character-a', 'あやめ', 'characters/character-a/icon.png', 'active', '2026-11-05', '2026-11-05'),
          ('character-b', ' あやめ ', '', 'archived', '2026-11-05', '2026-11-05'),
          ('character-blank', '', '', 'active', '2026-11-05', '2026-11-05');
        INSERT INTO project_scopes_v6 (id, project_type, project_key, display_name, workspace_path, created_at, updated_at) VALUES
          ('project-a', 'directory', 'a', 'WithMate', 'C:/repo/a', '2026-11-05', '2026-11-05'),
          ('project-b', 'directory', 'b', ' WithMate ', 'C:/repo/b', '2026-11-05', '2026-11-05');
      `);
    } finally { db.close(); }
    worker = new MemoryV6WorkerClient({ dbPath, workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url) });
    const service = new MemoryV6ReviewService({ resolveDbPath: () => null, storage: worker.storage, userDataPath: directory });
    await runner({ service, worker, dbPath, directory });
  } finally {
    await worker?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function append(worker: MemoryV6WorkerClient, id: string, target: MemoryV6ResolvedTarget): Promise<void> {
  await worker.storage.appendEntry({
    id, target, kind: "note", title: "保存した内容", body: `本文 ${id}`, preview: "短い本文",
    tags: [{ type: "topic", value: "review", canonicalType: "topic", canonicalValue: "review" }],
    source: { type: "manual", sessionId: null, messageId: null, providerId: null },
    now: "2026-11-05T00:00:00.000Z",
  });
}

// @test-value v2
// kind = "contract"
// claim = "Reviewは4種targetの登録名と同名補足を一覧・詳細に同じ形で返し、名前検索とCharacter/ProjectのAND filterをSQLページングへ適用する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-foundation.md; docs/design/settings-ui.md" }
// fault = "target名を本文に依存させる、ANDをORへ変える、またはpagination後に名前filterする"
// observable = "実Workerを通ったReview serviceの候補・hit・詳細・cursor・forget後の結果と保存本文"
// observation_boundary = "component-behavior"
// scope = "Memory Review target identity and SQL search"
// lifecycle = "permanent"
// impact = "利用者が対象を取り違えて閲覧・忘却する"
// distinction = "型検査やUI fixtureではSQL filter、Worker配線、catalog相対iconの解決を検証できない"
// @end-test-value
test("Review targets and AND filters survive the real Worker", async () => {
  await withReviewWorker(async ({ service, worker, directory }) => {
    await append(worker, "user", { owner: { type: "user", id: "local-user" }, scope: { type: "global", id: "global" } });
    await append(worker, "project", { owner: { type: "project", id: "project-a" }, scope: { type: "project", id: "project-a" } });
    await append(worker, "character", { owner: { type: "character", id: "character-a" }, scope: { type: "character", id: "character-a" } });
    await append(worker, "character-project-a", { owner: { type: "character", id: "character-a" }, scope: { type: "project", id: "project-a" } });
    await append(worker, "character-project-b", { owner: { type: "character", id: "character-a" }, scope: { type: "project", id: "project-b" } });
    await append(worker, "other-character", { owner: { type: "character", id: "character-b" }, scope: { type: "project", id: "project-a" } });

    const targets = await service.listTargets();
    assert.deepEqual(targets.characters.find((item) => item.id === "character-a"), {
      id: "character-a", name: "あやめ", iconFilePath: join(directory, "characters/character-a/icon.png"), state: "active", disambiguation: "character-a",
    });
    assert.equal(targets.characters.find((item) => item.id === "character-b")?.state, "archived");
    assert.equal(targets.characters.find((item) => item.id === "character-blank")?.name, null);
    assert.equal(targets.characters.find((item) => item.id === "character-b")?.iconFilePath, null);
    assert.notEqual(targets.projects[0]?.disambiguation, targets.projects[1]?.disambiguation);

    const all = await service.searchEntries({ query: "" });
    for (const [id, kind] of [["user", "user-global"], ["project", "project"], ["character", "character"], ["character-project-a", "character-project"]]) {
      const hit = all.items.find((item) => item.id === id)!;
      const detail = (await service.getEntry(id!))!;
      assert.equal(hit.target.kind, kind);
      assert.deepEqual(detail.target, hit.target);
    }

    const filter = { query: "WithMate", characterId: "character-a", projectId: "project-a", kinds: ["note" as const], limit: 1 };
    assert.deepEqual((await service.searchEntries(filter)).items.map((item) => item.id), ["character-project-a"]);
    assert.deepEqual((await service.searchEntries({ query: "あやめ", projectId: "project-b" })).items.map((item) => item.id), ["character-project-b"]);
    assert.deepEqual((await service.searchEntries({ query: "本文 character-project-a", characterId: "character-a" })).items.map((item) => item.id), ["character-project-a"]);
    assert.equal((await service.searchEntries({ query: "review", characterId: "character-a" })).items.length, 3);
    assert.equal((await service.searchEntries({ ...filter, kinds: ["decision"] })).items.length, 0);

    const page1 = await service.searchEntries({ query: "WithMate", projectId: "project-a", limit: 1 });
    assert.ok(page1.nextCursor);
    const page2 = await service.searchEntries({ query: "WithMate", projectId: "project-a", limit: 1, cursor: page1.nextCursor });
    const page3 = await service.searchEntries({ query: "WithMate", projectId: "project-a", limit: 1, cursor: page2.nextCursor });
    assert.deepEqual([...page1.items, ...page2.items, ...page3.items].map((item) => item.id), ["project", "other-character", "character-project-a"]);
    assert.equal(page3.nextCursor, undefined);

    assert.equal((await service.forgetEntry("character-project-a", "incorrect")).status, "forgotten");
    assert.equal(await service.getEntry("character-project-a"), null);
    assert.equal((await service.searchEntries(filter)).items.length, 0);
    const saved = await worker.storage.getEntry("character-project-a");
    assert.equal(saved?.body, "本文 character-project-a");
    assert.deepEqual(saved?.owner, { type: "character", id: "character-a" });
    assert.deepEqual(saved?.scope, { type: "project", id: "project-a" });
  });
});

// @test-value v2
// kind = "contract"
// claim = "登録参照の消失は元ID付きmissing投影として扱い、metadata取得失敗は空検索や欠落表示へ変換せず拒否する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-foundation.md; docs/design/settings-ui.md" }
// fault = "存在しないtargetを別Characterで補うか、catalog SQL失敗を正常な空結果へ置換する"
// observable = "実WorkerのReview候補・一覧・詳細に残るtarget IDと状態、metadata障害後のPromise拒否"
// observation_boundary = "component-behavior"
// scope = "Memory Review missing references and read failures"
// lifecycle = "permanent"
// impact = "対象消失と取得障害を混同して記憶を見失う"
// distinction = "型検査は参照欠落とSQLite read障害を区別できず、UI mockはWorker例外伝播を通らない"
// @end-test-value
test("Review preserves missing target IDs and rejects metadata read failures", async () => {
  await withReviewWorker(async ({ service, worker, dbPath }) => {
    await append(worker, "lost", { owner: { type: "character", id: "deleted-character" }, scope: { type: "project", id: "deleted-project" } });
    const detail = (await service.getEntry("lost"))!;
    assert.deepEqual(detail.target, {
      kind: "character-project",
      character: { id: "deleted-character", name: null, iconFilePath: null, state: "missing" },
      project: { id: "deleted-project", name: null, path: null, state: "missing" },
    });
    assert.deepEqual((await service.searchEntries({ query: "", characterId: "deleted-character", projectId: "deleted-project" })).items[0]?.target, detail.target);
    const candidates = await service.listTargets();
    assert.deepEqual(candidates.characters.find((item) => item.id === "deleted-character"), detail.target.character);
    await assert.rejects(service.searchEntries({ query: "", characterId: " " }), /characterId/);
    const db = new DatabaseSync(dbPath);
    try { db.exec("ALTER TABLE characters RENAME COLUMN name TO unavailable_name"); } finally { db.close(); }
    await assert.rejects(service.listTargets(), /name/);
    await assert.rejects(service.searchEntries({ query: "" }), /name/);
    await assert.rejects(service.getEntry("lost"), /name/);
  });
});
