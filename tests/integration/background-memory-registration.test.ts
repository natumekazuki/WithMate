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
// claim = "二用途のpresetまたは編集本文を受け取った同一Agent実行からMCPと配布CLIで実Memoryを登録する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの登録本文と直接登録" }
// fault = "用途入力がrunOnceへ届かないか、実用途handlerが公開登録からWorkerへ接続されていない"
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
    for (const purpose of purposes) for (const instructionText of [undefined, "サブエージェントを使わない。必要な記録を登録する。"] as const) {
      const ids: string[] = [];
      const calls = new BackgroundCallService({ executions: f.executions, runAgent: async (agent) => {
        const body = agent.userInput.split("# 登録指示本文\n\n")[1]!.split("\n\n# 実行情報")[0];
        assert.equal(body, instructionText ?? MEMORY_REGISTRATION_PRESETS[purpose]);
        assert.ok(agent.userInput.includes("saved answer"));
        const binding = project(f, agent);
        const { client } = await f.connect(binding, "memoryUrl");
        const mcpOp = operation(purpose, `${purpose}-${instructionText === undefined ? "preset" : "edited"}-mcp`);
        const mcp = await client.callTool({ name: mcpOp.tool, arguments: mcpOp.input });
        assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
        const mcpValue = mcp.structuredContent as { entry: { id: string } };
        ids.push(mcpValue.entry.id);
        const cliOp = operation(purpose, `${purpose}-${instructionText === undefined ? "preset" : "edited"}-cli`);
        const child = await cli(f, binding, cliOp);
        assert.equal(child.code, 0, JSON.stringify(child.value));
        ids.push(child.value.entry.id);
        for (const [index, op] of [mcpOp, cliOp].entries()) {
          const saved = (await f.memoryWorker.storage.getEntry(ids[index]))!;
          assert.equal(saved.body, `body ${op.input.idempotencyKey}`);
          assert.equal(saved.owner.type, purpose === "character-memory" ? "character" : "user");
          assert.equal(saved.scope.type, purpose === "character-memory" ? "character" : "global");
        }
      } });
      assert.deepEqual(await runBackgroundMemoryRegistration(calls, { context: context(f, purpose),
        selection: { providerId: "claude", modelId: "test" }, onAdmitted() {}, materials: "saved answer", instructionText }), { kind: "completed" });
      assert.equal(ids.length, 2);
    }
    assert.equal(count(f), 8);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "用途handlerは保存済み終端Turnがhistoryとprocessingに属さない場合および通常入力不正をMCPとCLIで拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memoryの登録本文と直接登録" }
// fault = "未保存・未完了・processing外のsourceを許容するか、既存append validatorを迂回する"
// observable = "実MCPのisErrorとCLI非zeroおよび保存件数0"
// observation_boundary = "public-boundary"
// scope = "production Memory registration handlers over real source reader and ordinary validators"
// lifecycle = "permanent"
// distinction = "共通認可testは用途handler固有のprocessing所属と通常validatorへの委譲を検査しない"
// @end-test-value
test("Memoryの根拠範囲と不正入力をMCPと配布CLIで拒否する", async () => {
  const f = await fixture(undefined, backgroundMemoryRegistrationHandlers);
  try {
    seed(f);
    for (const purpose of purposes) for (const invalid of ["missing", "running", "processing", "history", "input", "target"] as const) {
      f.db.prepare("UPDATE session_turns_v6 SET phase = ?, assistant_message_seq = ? WHERE id = 1")
        .run(invalid === "running" ? "running" : "completed", invalid === "history" ? 0 : 1);
      const ctx = context(f, purpose);
      if (invalid === "missing") f.db.prepare("DELETE FROM session_turns_v6 WHERE id = 1").run();
      if (invalid === "processing") ctx.scope = { ...ctx.scope, processing: { afterTurnId: 1, throughTurnId: 2 } };
      if (invalid === "history") ctx.scope = { ...ctx.scope, history: { ...ctx.scope.history, fromMessageSeq: 1 } };
      if (invalid === "target") ctx.scope = { ...ctx.scope, memoryTargets: [] };
      const execution = f.executions.begin({ ...ctx, providerId: "claude" });
      assert.ok(execution.ok);
      const binding = f.project(execution.execution);
      const { client } = await f.connect(binding, "memoryUrl");
      const op = operation(purpose, `bad-${purpose}-${invalid}`);
      if (invalid === "input") {
        if (purpose === "character-memory") delete op.input.episode.observedFact;
        else op.input.body = "";
      }
      const mcp = await client.callTool({ name: op.tool, arguments: op.input });
      assert.equal(mcp.isError, true, JSON.stringify(mcp));
      assert.notEqual((await cli(f, binding, op)).code, 0);
      f.executions.finish(execution.execution);
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
