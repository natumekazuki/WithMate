import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
import { MEMORY_REGISTRATION_PRESETS, type MemoryRegistrationScope } from "../../src-shared/memory-recording/memory-registration-input.js";
import { backgroundMemoryRegistrationHandlers, runBackgroundMemoryRegistration } from "../../src-electron/memory/background-memory-registration.js";
import { BackgroundCallService, type BackgroundCallContext, type BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { backgroundHistoryFixture as fixture, owner } from "../helpers/background-history-fixture.js";
import { ensureV6Schema } from "../../src-electron/storage/database-schema-v6.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Purpose = MemoryRegistrationScope["purpose"];
const purposes = ["character-memory", "target-memory"] as const;
const completedAt = "2026-11-01T01:00:00.000Z";
const targets = [{ owner: "user", scope: "global" },
  { owner: "character", scope: "character", character: { type: "id", id: "character" } }] as const;
const execFileAsync = promisify(execFile);
let directory: string;
let artifact: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "withmate-memory-registration-cli-"));
  artifact = await buildWithMateMemoryCli(directory);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

function seed(f: Fixture) {
  f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
    VALUES (1,'main','completed',1,?,?,?)`).run(completedAt, completedAt, completedAt);
}
function context(f: Fixture, purpose: Purpose): BackgroundCallContext & { scope: MemoryRegistrationScope } {
  return { actorSessionId: "main", session: f.sessions.get("main")!,
    scope: { ...f.scope("main", purpose), purpose, memoryTargets: targets },
    authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
    operationGrants: [...getBackgroundMemoryReadOperations(), BACKGROUND_REGISTRATION_OPERATIONS[purpose].operation] };
}
function operation(purpose: Purpose, key: string) {
  return purpose === "target-memory"
    ? { tool: "memory.append", command: "append", input: {
      target: { kind: "user-global" }, kind: "note", title: key, body: `body ${key}`, preview: key, tags: [], idempotencyKey: key,
    } as Record<string, any> }
    : { tool: "character_memory.append_episode", command: "character-memory-append-episode", input: {
      idempotencyKey: key, episode: { title: key, body: `body ${key}`, preview: key, observedFact: "A saved conversation took place." },
    } as Record<string, any> };
}
function project(f: Fixture, agent: BackgroundAgentInput) {
  const binding = { ...agent.binding, memoryRuntimeOwner: owner };
  return { ...binding, managedMcp: f.host.issue(binding, agent.handle, agent.signal) };
}
async function cli(f: Fixture, binding: ProviderAgentRuntimeBindingProjection, op: ReturnType<typeof operation>) {
  const result = await execFileAsync(process.execPath, [artifact, op.command, "--json", JSON.stringify(op.input)], {
    cwd: f.directory, env: f.cliEnv(binding), timeout: 15_000, windowsHide: true,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(typeof error.code, "number", error.stderr);
    return { code: error.code, stdout: error.stdout };
  });
  return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
}
function count(f: Fixture) { return f.db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get()!.count; }

// @test-value v2
// kind = "contract"
// claim = "presetと空文字列を含む編集本文とCharacter定義をAgentへ渡し、MCPと配布CLIの実登録で本人の語りを保持する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの登録本文と直接登録" }
// fault = "編集本文にpresetを重ねるか定義を欠落させるか、公開登録から保存・取得の間で本人の語りを改変する"
// observable = "Agentへ渡る指示本文、MCPとCLIの登録応答、Workerの本文と保存先、runOnceの終了結果"
// observation_boundary = "public-boundary"
// scope = "Memory purpose assembly through runOnce, production handlers, MCP, bundled CLI and Worker store"
// lifecycle = "permanent"
// distinction = "共通基盤のfixture adapter検証では実用途の組立てとhandlerを通らない"
// @end-test-value
test("Memory二用途の実handlerへ同一AgentからMCPと配布CLIで登録する", async () => {
  const f = await fixture(undefined, backgroundMemoryRegistrationHandlers);
  try {
    seed(f);
    for (const purpose of purposes) for (const instructionText of [undefined, "サブエージェントを使わない。必要な記録を登録する。", ""] as const) {
      const ids: string[] = [];
      const calls = new BackgroundCallService({ executions: f.executions, runAgent: async (agent) => {
        const body = agent.userInput.split("# 登録指示本文\n\n")[1]!.split("\n\n# 実行情報")[0];
        assert.equal(body, instructionText ?? MEMORY_REGISTRATION_PRESETS[purpose]);
        if (purpose === "character-memory") assert.ok(agent.userInput.includes("一人称はうち。親しい口調で話す。"));
        assert.ok(agent.userInput.includes("saved answer"));
        const binding = project(f, agent);
        const { client } = await f.connect(binding, "memoryUrl");
        const label = instructionText === undefined ? "preset" : instructionText === "" ? "empty" : "edited";
        const mcpOp = operation(purpose, `${purpose}-${label}-mcp`);
        if (purpose === "character-memory") mcpOp.input.episode.body = "うち、一緒に話せてうれしかった。この話、また思い出したいな。";
        const mcp = await client.callTool({ name: mcpOp.tool, arguments: mcpOp.input });
        assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
        const mcpValue = mcp.structuredContent as { entry: { id: string } };
        ids.push(mcpValue.entry.id);
        const cliOp = operation(purpose, `${purpose}-${label}-cli`);
        if (purpose === "character-memory") cliOp.input.episode.body = "うち、一緒に話せてうれしかった。この話、また思い出したいな。";
        const child = await cli(f, binding, cliOp);
        assert.equal(child.code, 0, JSON.stringify(child.value));
        ids.push(child.value.entry.id);
        for (const [index, op] of [mcpOp, cliOp].entries()) {
          const saved = (await f.memoryWorker.storage.getEntry(ids[index]))!;
          assert.equal(saved.body, purpose === "character-memory" ? op.input.episode.body : op.input.body);
          assert.equal(saved.owner.type, purpose === "character-memory" ? "character" : "user");
          assert.equal(saved.scope.type, purpose === "character-memory" ? "character" : "global");
        }
      } });
      assert.deepEqual(await runBackgroundMemoryRegistration(calls, { context: context(f, purpose),
        selection: { providerId: "claude", modelId: "test" }, onAdmitted() {}, materials: "saved answer", instructionText,
        ...(purpose === "character-memory" ? { characterDefinition: "一人称はうち。親しい口調で話す。" } : {}) }), { kind: "completed" });
      assert.equal(ids.length, 2);
    }
    assert.equal(count(f), 12);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "用途handlerは許可historyに保存済み終端Turnがない場合および通常入力不正をMCPとCLIで拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの登録本文と直接登録" }
// fault = "未保存・未完了・完了時刻欠落・他owner・history外のsourceを許容するか、既存append validatorを迂回する"
// observable = "実MCPのisErrorとCLI非zeroおよび保存件数0"
// observation_boundary = "public-boundary"
// scope = "production Memory registration handlers over real source reader and ordinary validators"
// lifecycle = "permanent"
// distinction = "共通認可testは用途handler固有の保存済み終端証拠と通常validatorへの委譲を検査しない"
// @end-test-value
test("Memoryの根拠範囲と不正入力をMCPと配布CLIで拒否する", async () => {
  const f = await fixture(undefined, backgroundMemoryRegistrationHandlers);
  try {
    seed(f);
    for (const purpose of purposes) for (const invalid of ["missing", "running", "unfinished", "owner", "history", "input", "target"] as const) {
      f.db.prepare("UPDATE session_turns_v6 SET phase = ?, assistant_message_seq = ?, completed_at = ?, session_id = ? WHERE id = 1")
        .run(invalid === "running" ? "running" : "completed", invalid === "history" ? 0 : 1,
          invalid === "unfinished" ? null : completedAt, invalid === "owner" ? "other" : "main");
      const ctx = context(f, purpose);
      if (invalid === "missing") f.db.prepare("DELETE FROM session_turns_v6 WHERE id = 1").run();
      if (invalid === "history") ctx.scope = { ...ctx.scope, history: { ...ctx.scope.history, fromMessageSeq: 1 } };
      if (invalid === "target") ctx.scope = { ...ctx.scope, memoryTargets: [] };
      const execution = f.executions.begin({ ...ctx, providerId: "claude" });
      const binding = f.project(execution);
      const { client } = await f.connect(binding, "memoryUrl");
      const op = operation(purpose, `bad-${purpose}-${invalid}`);
      if (invalid === "input") {
        if (purpose === "character-memory") delete op.input.episode.observedFact;
        else op.input.body = "";
      }
      const mcp = await client.callTool({ name: op.tool, arguments: op.input });
      assert.equal(mcp.isError, true, JSON.stringify(mcp));
      assert.notEqual((await cli(f, binding, op)).code, 0);
      f.executions.finish(execution);
      assert.equal(count(f), 0);
      if (invalid === "missing") seed(f);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "登録なしでAgentは完了でき、後続失敗・取消でも先行保存は残り終了済みCLIから追加保存しない"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#維持する境界" }
// fault = "登録なしを失敗にするか、後続Agent失敗で保存を戻すか、失効後にも登録できる"
// observable = "runOnceのcompleted/failed/canceled、先行entryの実本文、失効CLIの非zeroと保存件数"
// observation_boundary = "public-boundary"
// scope = "production Memory registration through BackgroundCallService and shared execution lifetime"
// lifecycle = "permanent"
// distinction = "共通基盤の終了testと異なり実用途入口から両Memory handlerを使い保存効果とAgent終了を分離する"
// @end-test-value
test("登録なしと部分保存後のAgent失敗・取消を区別する", async () => {
  const f = await fixture(undefined, backgroundMemoryRegistrationHandlers);
  try {
    seed(f);
    for (const purpose of purposes) {
      const noRegistration = new BackgroundCallService({ executions: f.executions, runAgent() {} });
      assert.deepEqual(await runBackgroundMemoryRegistration(noRegistration, { context: context(f, purpose),
        selection: { providerId: "claude", modelId: "test" }, onAdmitted() {}, materials: "" }), { kind: "completed" });
    }
    assert.equal(count(f), 0);
    for (const purpose of purposes) for (const end of ["failed", "canceled"] as const) {
      let binding!: ReturnType<typeof project>;
      let entryId!: string;
      const calls = new BackgroundCallService({ executions: f.executions, runAgent: async (agent) => {
        binding = project(f, agent);
        const saved = await cli(f, binding, operation(purpose, `${purpose}-${end}`));
        assert.equal(saved.code, 0, JSON.stringify(saved.value));
        entryId = saved.value.entry.id;
        if (end === "canceled") f.executions.cancel(agent.binding.bindingId);
        else throw new Error("Agent failed after the registration response");
      } });
      const result = await runBackgroundMemoryRegistration(calls, { context: context(f, purpose),
        selection: { providerId: "claude", modelId: "test" }, onAdmitted() {}, materials: "saved source" });
      assert.equal(result.kind, end);
      assert.equal((await f.memoryWorker.storage.getEntry(entryId))!.body, `body ${purpose}-${end}`);
      assert.notEqual((await cli(f, binding, operation(purpose, `${purpose}-${end}-late`))).code, 0);
    }
    assert.equal(count(f), 4);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary二用途は実Auxiliary出典をMCPと配布CLIから保存し、同名Mainへ混同せず失効後も先行保存を保持する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの登録本文と直接登録" }
// fault = "AuxiliaryをMainの出典FKへ流すか、owner列を混同し、失効後に追加保存する"
// observable = "MCPとCLIの登録結果、Workerの本文とsource、拒否応答、Aux削除後の先行entryとFK検査"
// observation_boundary = "public-boundary"
// scope = "production Memory handlers with real Auxiliary source, same-ID Main, bundled CLI, MCP and SQLite"
// lifecycle = "permanent"
// distinction = "Main登録testはAuxiliaryのNULL sessionId・専用owner列と出典FKの保存を検査しない"
// @end-test-value
test("Auxiliaryの二用途を実storeへ登録し同名Mainと区別する", async () => {
  const f = await fixture(undefined, backgroundMemoryRegistrationHandlers, undefined,
    { "character-memory": ["main", "auxiliary"], "target-memory": ["main", "auxiliary"] });
  try {
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','different-main','Same ID','active','codex',1,'test','on-request','character','{}','now','now','now')`).run();
    f.db.prepare("INSERT INTO auxiliary_session_messages(auxiliary_session_id,seq,role,body,created_at) VALUES ('aux',1,'assistant',?,'now')")
      .run(JSON.stringify({ role: "assistant", text: "actual Auxiliary conversation" }));
    f.db.prepare(`INSERT INTO session_turns_v6(id,auxiliary_session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
      VALUES (50,'aux','completed',1,?,?,?)`).run(completedAt, completedAt, completedAt);
    const entries: string[] = [];
    for (const purpose of purposes) {
      const base = context(f, purpose);
      const scope = { ...f.scope("aux", purpose), history: { ...f.scope("aux", purpose).history, throughMessageSeq: 1 },
        memoryTargets: targets };
      const execution = f.executions.begin({ ...base, session: f.sessions.get("aux")!, actorSessionId: "aux", providerId: "claude", scope });
      const binding = f.project(execution);
      const { client } = await f.connect(binding, "memoryUrl");
      const op = operation(purpose, `aux-${purpose}-mcp`);
      const result = await client.callTool({ name: op.tool, arguments: op.input });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      entries.push((result.structuredContent as { entry: { id: string } }).entry.id);
      const child = await cli(f, binding, operation(purpose, `aux-${purpose}-cli`));
      assert.equal(child.code, 0, JSON.stringify(child.value)); entries.push(child.value.entry.id);
      const invalid = operation(purpose, "not-allowed");
      if (purpose === "target-memory") invalid.input.target = { kind: "project", project: { type: "id", id: "not-allowed" } };
      else invalid.input.episode.observedFact = "";
      assert.equal((await client.callTool({ name: invalid.tool, arguments: invalid.input })).isError, true);
      assert.notEqual((await cli(f, binding, invalid)).code, 0);
      const forged = operation(purpose, "forged-owner"); forged.input.characterId = "another-character";
      assert.equal((await client.callTool({ name: forged.tool, arguments: forged.input })).isError, true);
      assert.notEqual((await cli(f, binding, forged)).code, 0);
      f.executions.cancel(execution.binding.bindingId);
      assert.notEqual((await cli(f, binding, operation(purpose, "late"))).code, 0);
    }
    assert.equal(entries.length, 4);
    for (const id of entries) {
      const entry = (await f.memoryWorker.storage.getEntry(id))!;
      assert.equal(entry.source.sessionId, null); assert.equal(entry.source.auxiliarySessionId, "aux");
      assert.ok(entry.body.startsWith("body aux-"));
    }
    f.db.prepare("DELETE FROM auxiliary_sessions WHERE id = 'aux'").run();
    for (const id of entries) {
      const entry = (await f.memoryWorker.storage.getEntry(id))!;
      assert.equal(entry.source.sessionId, null); assert.equal(entry.source.auxiliarySessionId, undefined);
      assert.ok(entry.body.startsWith("body aux-"));
    }
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "既存V6へAuxiliary出典列を追加しても保存済みMain MemoryとFKを保持し、schema更新を再実行できる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md" }
// fault = "出典拡張で既存entryを消すか、既存V6を更新せず新selectが失敗する"
// observable = "schema更新前後の実Worker entryとFK検査"
// observation_boundary = "component-behavior"
// scope = "V6 schema upgrade for Auxiliary Memory provenance with isolated real SQLite and Worker"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary出典のschema更新は既存Memoryを保持する", async () => {
  const f = await fixture();
  try {
    const input = operation("target-memory", "retained");
    const saved = await f.memory.append({ type: "session_binding", sessionId: "main", characterId: "character",
      providerId: "codex", bindingIdHash: "migration-fixture", permissions: ["memory.append"] }, { ...input.input,
      target: { owner: "user", scope: "global" }, schemaVersion: MEMORY_V6_SCHEMA_VERSION });
    assert.ok("entry" in saved, JSON.stringify(saved));
    const before = await f.memoryWorker.storage.getEntry(saved.entry.id);
    assert.equal(before?.source.sessionId, "main");
    // Construct the preceding V6 shape in this isolated test DB; no user database is used.
    f.db.exec("ALTER TABLE memory_entries_v6 DROP COLUMN source_auxiliary_session_id");
    ensureV6Schema(f.db); ensureV6Schema(f.db);
    assert.deepEqual(await f.memoryWorker.storage.getEntry(saved.entry.id), before);
    assert.ok(f.db.prepare("PRAGMA table_info(memory_entries_v6)").all().some((row) => row.name === "source_auxiliary_session_id"));
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});
