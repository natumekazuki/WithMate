import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { BACKGROUND_REGISTRATION_OPERATIONS, getBackgroundMemoryFileOperations } from "../../src-shared/agent-runtime/background-operations.js";
import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { MEMORY_FILE_QUOTA_MIN_BYTES } from "../../src-shared/settings/provider-settings-state.js";
import { backgroundMemoryRegistrationHandlers } from "../../src-electron/memory/background-memory-registration.js";
import { registerBackgroundAffect } from "../../src-electron/character/background-affect-registration.js";
import { captureBackgroundMemoryFileAccess } from "../../src-electron/memory/memory-file-access.js";
import { inspectMemoryProtectedObjectInputFile, prepareMemoryProtectedObjectFile } from "../../src-electron/memory/memory-protected-object-importer.js";
import { MemoryProtectedObjectStore } from "../../src-electron/memory/memory-protected-object-store.js";
import { backgroundHistoryFixture as fixture, owner } from "../helpers/background-history-fixture.js";

const execFileAsync = promisify(execFile);
const target = { owner: "user", scope: "global" } as const;
const publicTarget = { kind: "user-global" } as const;
const time = "2026-11-03T00:00:00.000Z";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Binding = ReturnType<Fixture["project"]>;
type Json = Record<string, any>;
let cliDirectory: string;
let cliArtifact: string;
before(async () => {
  cliDirectory = await mkdtemp(join(tmpdir(), "withmate-batch-cli-"));
  cliArtifact = await buildWithMateMemoryCli(cliDirectory);
});
after(async () => { await rm(cliDirectory, { recursive: true, force: true }); });

async function setup() {
  let beforePrepare: (() => void) | undefined;
  let preparations = 0;
  let failAt = 0;
  let objectDirectory = "";
  const f = await fixture(undefined, { ...backgroundMemoryRegistrationHandlers, affect: registerBackgroundAffect },
    () => new Date(time), undefined, (directory) => {
      objectDirectory = join(directory, "objects");
      const objectStore = MemoryProtectedObjectStore.fromUserDataPath(objectDirectory);
      // Only OS key protection is replaced: real importer crypto, object store and DB Worker remain in use.
      const key = { keyId: "b".repeat(32), key: Buffer.alloc(32, 23) };
      const keyStore = {
        async getOrCreateActiveKey() {
          if (preparations === failAt) throw new Error("injected key I/O failure");
          return key;
        },
        async readKey(id: string) { return id === key.keyId ? key : null; },
      };
      return {
        getMemoryFileQuotaBytes: () => MEMORY_FILE_QUOTA_MIN_BYTES,
        protectedObjectImporter: {
          inspect: inspectMemoryProtectedObjectInputFile,
          prepare: async (input) => {
            preparations++;
            beforePrepare?.();
            return prepareMemoryProtectedObjectFile({ keyStore, objectStore }, input);
          },
          discardPrepared: async ({ objectId }) => { await objectStore.deleteObject(objectId); },
        },
      };
    });
  f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
    VALUES (1,'main','completed',1,?,?,?)`).run(time, time, time);
  const workspace = join(f.directory, "workspace"); await mkdir(workspace);
  const sessionFolder = join(f.directory, "session-folder"); await mkdir(sessionFolder);
  const inputPath = join(workspace, "evidence.txt"); await writeFile(inputPath, "retained batch evidence");
  const fileAccess = await captureBackgroundMemoryFileAccess({ readRoots: [workspace, sessionFolder], sessionFolderPath: sessionFolder, writable: true });
  return { f, inputPath, objectDirectory, fileAccess,
    failAt: (count: number) => { failAt = count; },
    beforePrepare: (hook?: () => void) => { beforePrepare = hook; },
    preparations: () => preparations };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function entry(key: string, filePath?: string, files = 1) {
  return { kind: "note", title: key, body: `Independent retained observation ${key}.`, preview: key, tags: [], idempotencyKey: key,
    ...(filePath ? { files: Array.from({ length: files }, () => ({ path: filePath, summary: "Supporting evidence", role: "evidence" })) } : {}) };
}
function operation(purpose: "target-memory" | "character-memory", key: string, length: number) {
  const entries = Array.from({ length }, (_, index) => entry(`${key}-${index}`));
  return purpose === "target-memory"
    ? { tool: "memory.append", command: "append", input: { target: publicTarget, entries } as Json,
      bodies: entries.map((item) => item.body) }
    : { tool: "character_memory.append_episode", command: "character-memory-append-episode", input: {
      episodes: entries.map((item) => ({ idempotencyKey: item.idempotencyKey, episode: {
        title: item.title, body: item.body, preview: item.preview, observedFact: `Saved conversation observation ${item.title}`,
      } })),
    } as Json, bodies: entries.map((item) => item.body) };
}
function start(s: Setup, purpose: BackgroundPurpose = "target-memory") {
  return s.f.started("main", "claude", purpose, undefined,
    [...getBackgroundMemoryFileOperations(), BACKGROUND_REGISTRATION_OPERATIONS[purpose].operation],
    { memoryTargets: [target, { owner: "character", scope: "character", character: { type: "id", id: "character" } }], fileAccess: s.fileAccess });
}
function normal(f: Fixture) {
  const binding = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex",
    authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
    operationGrants: Object.values(BACKGROUND_REGISTRATION_OPERATIONS).map((item) => item.operation) });
  const handle = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
  const projected = { ...binding, turnCapability: handle.capability, memoryRuntimeOwner: owner };
  return { handle, binding: { ...projected, managedMcp: f.host.issue(projected, handle) } };
}
async function cli(f: Fixture, binding: Binding, command: string, input: Json) {
  const child = await execFileAsync(process.execPath, [cliArtifact, command, "--json", JSON.stringify(input)], {
    cwd: f.directory, env: f.cliEnv(binding), windowsHide: true, timeout: 15_000,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(typeof error.code, "number", error.stderr); return { code: error.code, stdout: error.stdout };
  });
  return { code: child.code, value: JSON.parse(child.stdout) as Json };
}
function counts(f: Fixture) {
  return ["memory_entries_v6", "memory_protected_objects_v6"].map((table) => Number(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count));
}
async function assertSaved(f: Fixture, value: Json, bodies: string[]) {
  assert.equal(value.results.length, bodies.length, JSON.stringify(value));
  const ids: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const result = value.results[index];
    assert.equal(result.index, index); assert.equal(result.status, "saved", JSON.stringify(result));
    const id = result.result.entry.id; ids.push(id);
    assert.equal((await f.memoryWorker.storage.getEntry(id))!.body, body);
  }
  assert.equal(new Set(ids).size, bodies.length);
  return ids;
}

// @test-value v2
// kind = "contract"
// claim = "通常と背景のMCP・配布CLIは1件と11件のMemory/episodeを独立した入力順の結果として保存し同一実行の再呼出も受理する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#一括登録と項目別結果" }
// fault = "公開schemaだけが配列を受け取りrouteが単件処理する、項目を連結・切捨てする、Turn合計制限で後続呼出を拒否する"
// observable = "公開応答のindex/status/ID、Workerから取得した個別本文、実DB件数"
// observation_boundary = "public-boundary"
// scope = "normal and background managed MCP/bundled CLI through production handlers/application and real DB Worker"
// lifecycle = "permanent"
// distinction = "schemaやapplication単体では四つの公開入口から実Worker保存までの配線と同一実行内反復を検出しない"
// @end-test-value
test("Memory二用途の一括登録は通常・背景のMCPと配布CLIで独立記録になる", async () => {
  const s = await setup(); const { f } = s;
  try {
    for (const background of [false, true]) for (const purpose of ["target-memory", "character-memory"] as const) {
      const active = background ? start(s, purpose) : normal(f);
      const binding = background ? f.project(active as ReturnType<typeof start>) : (active as ReturnType<typeof normal>).binding;
      const { client } = await f.connect(binding, "memoryUrl");
      for (const size of [1, 11]) {
        const mcpOp = operation(purpose, `${background}-${purpose}-mcp-${size}`, size);
        const mcp = await client.callTool({ name: mcpOp.tool, arguments: mcpOp.input });
        assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
        await assertSaved(f, mcp.structuredContent as Json, mcpOp.bodies);
        const cliOp = operation(purpose, `${background}-${purpose}-cli-${size}`, size);
        const child = await cli(f, binding, cliOp.command, cliOp.input);
        assert.equal(child.code, 0, JSON.stringify(child)); await assertSaved(f, child.value, cliOp.bodies);
      }
      const before = counts(f);
      const invalid = operation(purpose, `${background}-${purpose}-invalid`, 2);
      if (purpose === "target-memory") invalid.input.entries[1].body = "";
      else invalid.input.episodes[1].episode.observedFact = "";
      assert.equal((await client.callTool({ name: invalid.tool, arguments: invalid.input })).isError, true);
      assert.notEqual((await cli(f, binding, invalid.command, invalid.input)).code, 0);
      assert.deepEqual(counts(f), before);
      if (background) f.executions.finish(active as ReturnType<typeof start>);
      else f.turns.end((active as ReturnType<typeof normal>).handle);
    }
    assert.deepEqual(counts(f), [96, 0]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "11件のAffect候補は通常と背景の両入口から全件保存され、同一背景内の複数呼出も切捨てられない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#一括登録と項目別結果" }
// fault = "schema・背景handler・applicationのいずれかに10件上限またはTurn累積上限が残る"
// observable = "MCP/CLIのsaved件数と実Affect eventのtargetId集合"
// observation_boundary = "public-boundary"
// scope = "Affect public inputs through production background handler/application and real affect Worker"
// lifecycle = "permanent"
// distinction = "候補schema単体では背景用identity補完とapplication保存への連結を確認できない"
// @end-test-value
test("Affectの11候補が通常・背景の公開入口から全て保存される", async () => {
  const s = await setup(); const { f } = s;
  try {
    const expected: string[] = [];
    for (const background of [false, true]) {
      const active = background ? start(s, "affect") : normal(f);
      const binding = background ? f.project(active as ReturnType<typeof start>) : (active as ReturnType<typeof normal>).binding;
      const { client } = await f.connect(binding, "memoryUrl");
      for (const adapter of ["mcp", "cli"]) {
        const candidates = Array.from({ length: 11 }, (_, index) => {
          const targetId = `${background}-${adapter}-${index}`; expected.push(targetId);
          return { layer: "session", targetType: "bug", targetId, family: "interest", value: { label: "interest", valence: 0.4 },
            intensity: 0.6, reason: "A reproduction was found.", evidence: "The saved answer identifies a reproduction.",
            ...(background ? { sourceTurnId: 1 } : { schemaVersion: "withmate-affect-v1", occurredAt: time, idempotencyKey: targetId }) };
        });
        if (adapter === "mcp") {
          const result = await client.callTool({ name: "character_affect.appraise", arguments: { candidates } });
          assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal((result.structuredContent as Json).saved.length, 11);
        } else {
          const result = await cli(f, binding, "affect-appraise", { candidates });
          assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.value.saved.length, 11);
        }
      }
      if (background) f.executions.finish(active as ReturnType<typeof start>); else f.turns.end((active as ReturnType<typeof normal>).handle);
    }
    assert.deepEqual(f.db.prepare("SELECT target_id FROM character_affect_events_v6").all().map((row) => row.target_id).sort(), expected.sort());
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "batchは保存開始前に全項目を検証し本文8000字と一件10添付を維持するが複数entryの添付数は合算しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#一括登録と項目別結果" }
// fault = "後方の入力不正より前に保存する、本文を切詰める、添付数をbatch合計へ適用する、単件形式と配列を混在受理する"
// observable = "両入口の拒否/成功、保存本文長・添付件数、全体拒否時のentry/object件数"
// observation_boundary = "public-boundary"
// scope = "production batch prevalidation with real protected object encryption and DB Worker"
// lifecycle = "permanent"
// distinction = "単件境界testでは後方不正の事前拒否とentry毎の添付上限をbatch合計と区別できない"
// @end-test-value
test("一括入力検証は全項目に適用し本文と添付の単件境界を維持する", async () => {
  const s = await setup(); const { f } = s;
  try {
    const execution = start(s), binding = f.project(execution); const { client } = await f.connect(binding, "memoryUrl");
    const malformed: Json[] = [
      { target: publicTarget, entries: [] },
      { target: publicTarget, entries: [entry("valid"), { ...entry("invalid"), body: "x".repeat(8001) }] },
      { target: publicTarget, entries: [entry("valid"), entry("too-many", s.inputPath, 11)] },
      { target: publicTarget, entries: [entry("valid")], ...entry("mixed") },
      { target: publicTarget, entries: [entry("valid"), { ...entry("identity"), target: { kind: "project", project: { type: "id", id: "foreign" } } }] },
      { target: { kind: "invalid" }, entries: [entry("valid")] },
    ];
    for (const input of malformed) {
      const mcp = await client.callTool({ name: "memory.append", arguments: input }); assert.equal(mcp.isError, true, JSON.stringify(mcp));
      assert.notEqual((await cli(f, binding, "append", input)).code, 0); assert.deepEqual(counts(f), [0, 0]);
      assert.equal(s.preparations(), 0);
    }
    const entries = [entry("six-a", s.inputPath, 6), entry("six-b", s.inputPath, 6), { ...entry("ten", s.inputPath, 10), body: "x".repeat(8000) }];
    const result = await cli(f, binding, "append", { target: publicTarget, entries }); assert.equal(result.code, 0, JSON.stringify(result));
    const ids = await assertSaved(f, result.value, entries.map((item) => item.body));
    for (const [index, id] of ids.entries()) assert.equal((await f.memoryWorker.storage.getEntry(id))!.files!.length, entries[index].files!.length);
    assert.deepEqual(counts(f), [3, 22]);
    f.executions.finish(execution);
    const character = start(s, "character-memory"), cb = f.project(character); const { client: cc } = await f.connect(cb, "memoryUrl");
    const op = operation("character-memory", "invalid-episode", 2); op.input.episodes[1].episode.body = "x".repeat(8001);
    assert.equal((await cc.callTool({ name: op.tool, arguments: op.input })).isError, true);
    assert.notEqual((await cli(f, cb, op.command, op.input)).code, 0); assert.deepEqual(counts(f), [3, 22]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "途中添付失敗は先行entryを保持し失敗項目を本文だけ保存せず後続を未実行にし、元file削除後の同一key再送でも先行添付は重複しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#一括登録と項目別結果" }
// fault = "失敗を全件成功にする、batchをrollbackする、後続保存する、replay前に元fileを読み直し添付を重複生成する"
// observable = "MCP isError/CLI exit、項目statusとerror.effect、Worker entry/body/files、DB件数とobject store一覧"
// observation_boundary = "public-boundary"
// scope = "real attachment importer/crypto/store with deterministic key-I/O failure and existing per-item idempotency"
// lifecycle = "permanent"
// distinction = "単件原子性testではbatch保存prefixとnot_run、部分失敗後に異なる公開入口で再送する動作を確認できない"
// @end-test-value
test("部分失敗と再送は確定prefix・添付原子性・項目冪等性を維持する", async () => {
  const s = await setup(); const { f } = s;
  try {
    const execution = start(s), binding = f.project(execution); const { client } = await f.connect(binding, "memoryUrl");
    s.failAt(2);
    const entries = [entry("prefix", s.inputPath), entry("failed", s.inputPath), entry("remaining")];
    const result = await client.callTool({ name: "memory.append", arguments: { target: publicTarget, entries } });
    assert.equal(result.isError, true, JSON.stringify(result)); const value = result.structuredContent as Json;
    assert.deepEqual(value.results.map((item: Json) => item.status), ["saved", "failed", "not_run"]);
    assert.equal(value.error.effect, "partial"); assert.deepEqual(counts(f), [1, 1]);
    const id = value.results[0].result.entry.id; const saved = (await f.memoryWorker.storage.getEntry(id))!;
    assert.equal(saved.body, entries[0].body); assert.equal(saved.files!.length, 1);
    const objectsBefore = await readdir(s.objectDirectory, { recursive: true });
    await rm(s.inputPath); s.failAt(0);
    const replay = await cli(f, binding, "append", { target: publicTarget, entries });
    assert.notEqual(replay.code, 0); assert.equal(replay.value.error.effect, "partial");
    assert.deepEqual(replay.value.results.map((item: Json) => item.status), ["saved", "failed", "not_run"]);
    assert.equal(replay.value.results[0].result.entry.id, id); assert.deepEqual(counts(f), [1, 1]);
    assert.deepEqual(await readdir(s.objectDirectory, { recursive: true }), objectsBefore);
    const reconsidered = await cli(f, binding, "append", { target: publicTarget, entries: [entries[0], entry("new-observation")] });
    assert.equal(reconsidered.code, 0, JSON.stringify(reconsidered)); assert.deepEqual(counts(f), [2, 1]);
    assert.equal(reconsidered.value.results[0].result.entry.id, id);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "一括登録でも現在bindingの失効とtarget/source権限を守り、取消後はprefixを保持して旧credentialの追加保存を拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#一括登録と項目別結果" }
// fault = "batch開始時の認可だけで後続を保存する、旧bindingを新実行へ転用する、共通targetや出典の権限を迂回する"
// observable = "取消後の項目結果・保存件数、旧CLI非zero、新実行CLI成功、許可外target/sourceへのMCP/CLI拒否"
// observation_boundary = "public-boundary"
// scope = "managed execution revocation through real production batch and importer admission"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "単件失効testはbatch内の二項目目のadmissionと保存済prefixを観測しない"
// @end-test-value
test("batch途中の取消と現在のtarget/source権限を両入口で守る", async () => {
  const s = await setup(); const { f } = s;
  try {
    const execution = start(s), binding = f.project(execution);
    // Cancel inside the second item's real importer, after the first has committed.
    s.beforePrepare(() => { if (s.preparations() === 2) f.executions.cancel(execution.binding.bindingId); });
    const result = await cli(f, binding, "append", { target: publicTarget,
      entries: [entry("before-cancel", s.inputPath), entry("during-cancel", s.inputPath), entry("after-cancel")] });
    assert.notEqual(result.code, 0, JSON.stringify(result)); const value = result.value;
    assert.equal(value.results[0].status, "saved"); assert.equal(value.results[2].status, "not_run");
    assert.equal(value.error.effect, "partial"); assert.deepEqual(counts(f), [1, 1]); s.beforePrepare();
    assert.notEqual((await cli(f, binding, "append", { target: publicTarget, entries: [entry("old-credential")] })).code, 0);
    const current = start(s), cb = f.project(current); const { client: cc } = await f.connect(cb, "memoryUrl");
    f.db.prepare(`INSERT INTO project_scopes_v6 (id,project_type,project_key,workspace_path,display_name,created_at,updated_at)
      VALUES ('foreign','directory','foreign',?,'Foreign','now','now')`).run(join(f.directory, "foreign"));
    const foreign = { target: { kind: "project", project: { type: "id", id: "foreign" } }, entries: [entry("forbidden")] };
    const forbidden = await cc.callTool({ name: "memory.append", arguments: foreign });
    assert.equal(forbidden.isError, true); assert.partialDeepStrictEqual(forbidden.structuredContent, { error: { field: "target", effect: "none" } });
    const forbiddenCli = await cli(f, cb, "append", foreign);
    assert.notEqual(forbiddenCli.code, 0); assert.partialDeepStrictEqual(forbiddenCli.value, { error: { field: "target", effect: "none" } });
    const outsidePath = join(f.directory, "outside.txt"); await writeFile(outsidePath, "outside approved file roots");
    const outside = { target: publicTarget, entries: [entry("outside-file", outsidePath)] };
    assert.equal((await cc.callTool({ name: "memory.append", arguments: outside })).isError, true);
    assert.notEqual((await cli(f, cb, "append", outside)).code, 0); assert.deepEqual(counts(f), [1, 1]);
    const success = await cli(f, cb, "append", { target: publicTarget, entries: [entry("new-credential")] }); assert.equal(success.code, 0, JSON.stringify(success));
    f.db.prepare("UPDATE session_turns_v6 SET session_id='other' WHERE id=1").run();
    const badSource = { target: publicTarget, entries: [entry("foreign-source")] };
    assert.equal((await cc.callTool({ name: "memory.append", arguments: badSource })).isError, true);
    assert.notEqual((await cli(f, cb, "append", badSource)).code, 0); assert.deepEqual(counts(f), [2, 1]);
  } finally { await f.close(); }
});
