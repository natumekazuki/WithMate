import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { registerBackgroundAffect } from "../../src-electron/character/background-affect-registration.js";
import { createAuxiliarySessionRuntime } from "../../src-electron/auxiliary/auxiliary-session-runtime-assembly.js";
import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { CharacterAffectContext } from "../../src-shared/character-context/character-context-contract.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../../src-shared/character-context/character-context-contract.js";
import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { backgroundHistoryFixture } from "../helpers/background-history-fixture.js";

const execFileAsync = promisify(execFile);
const time = "2026-11-03T00:00:00.000Z";
type Fixture = Awaited<ReturnType<typeof backgroundHistoryFixture>>;
type Binding = ReturnType<Fixture["project"]>;
let directory: string;
let artifact: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "withmate-aux-affect-cli-"));
  artifact = await buildWithMateMemoryCli(directory);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const f = await backgroundHistoryFixture(undefined, { affect: registerBackgroundAffect }, () => new Date(time), { affect: ["main", "auxiliary"] });
  f.db.prepare("INSERT INTO auxiliary_session_messages(auxiliary_session_id,seq,role,body,created_at) VALUES ('aux',1,'assistant',?,'now')")
    .run(JSON.stringify({ role: "assistant", text: "Auxiliary saved answer" }));
  f.db.prepare(`INSERT INTO session_turns_v6(id,auxiliary_session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
    VALUES (1,'aux','completed',1,?,?,?)`).run(time, time, time);
  return f;
}
function start(f: Fixture, change?: (scope: BackgroundExecutionScope) => BackgroundExecutionScope) {
  const initial = f.scope("aux");
  const scope = { ...initial, history: { ...initial.history, throughMessageSeq: 1 } };
  return f.executions.begin({ actorSessionId: "aux", providerId: "claude", session: f.sessions.get("aux")!,
    scope: change ? change(scope) : scope, authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
    operationGrants: [BACKGROUND_REGISTRATION_OPERATIONS.affect.operation] });
}
function candidate(targetId: string, sourceTurnId = 1) {
  return { sourceTurnId, layer: "session", targetType: "bug", targetId, family: "interest",
    value: { label: "interest", valence: 0.4, arousal: 0.3 }, intensity: 0.6,
    reason: "A reproduction was found.", evidence: "The Auxiliary saved answer identifies a reproduction." };
}
async function cli(f: Fixture, binding: Binding, input: Record<string, unknown>) {
  const result = await execFileAsync(process.execPath, [artifact, "affect-appraise", "--json", JSON.stringify(input)], {
    cwd: f.directory, env: f.cliEnv(binding), timeout: 15_000, windowsHide: true,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(typeof error.code, "number", error.stderr);
    return { code: error.code, stdout: error.stdout };
  });
  return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
}
async function context(f: Fixture, sessionId: string, source?: BackgroundExecutionScope["history"]["source"], characterId = "character") {
  const result = await f.characterContext.getContext({ schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId, sessionId, memoryLimit: 0 }, "internal", characterId === "character" ? undefined : {
    characterId, name: "Parent", description: "", iconFilePath: "", theme: { main: "#123456", sub: "#abcdef" },
    definitionMarkdown: "Parent", definitionSha256: "parent", definitionByteSize: 6, snapshotAt: time,
  }, source);
  assert.ok(!("error" in result), JSON.stringify(result));
  if ("error" in result) throw new Error(JSON.stringify(result));
  return result.affect.effective.map((component) => component.targetId).sort();
}

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの実MCP・配布CLI登録は実Auxiliary Characterと物理ownerへ保存し、同名Mainや異なるCharacterの親へ一時感情を混ぜず同Characterにはrelationshipだけ共有する"
// oracle = { type = "contract", ref = "docs/adr/018-character-affect-event-persistence.md" }
// fault = "Auxiliaryを親Mainか同名Mainへ保存・投影する、またはrelationshipのCharacter境界を取り違える"
// observable = "実source Turnのowner、MCP/CLI保存応答、SQLite owner/FK列、同一applicationから取得した各ownerのeffective context"
// observation_boundary = "public-boundary"
// scope = "bound MCP and bundled CLI through production Auxiliary handler, application and temporary DB Worker"
// lifecycle = "permanent"
// impact = "別会話や別Characterの一時感情が現在会話へ混入する"
// distinction = "storage単体ではmanaged bindingからtrusted sourceと実Characterがapplication contextまで届く配線を確認できない"
// @end-test-value
test("Auxiliary登録とcontextは実ownerを使いrelationshipだけ同Characterへ共有する", async () => {
  const f = await fixture();
  try {
    f.db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('parent-character','Parent','now','now')").run();
    f.db.prepare("UPDATE sessions_v6 SET character_id = 'parent-character' WHERE id = 'main'").run();
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','inc-same-name','Same-name Main','active','codex',1,'test','on-request','character','{}','now','now','now')`).run();
    const execution = start(f), binding = f.project(execution);
    const snapshot = await f.worker.stores.session.readBackgroundSource({ ...f.scope("aux").history, throughMessageSeq: 1 });
    assert.ok(snapshot);
    const source = f.scope("aux").history.source;
    assert.equal(source.kind, "auxiliary");
    assert.equal(snapshot.ownerIdentity, source.ownerIdentity);
    assert.partialDeepStrictEqual(snapshot.session, { id: "aux", incarnationId: source.incarnationId, characterId: "character" });
    if (source.kind === "auxiliary") assert.deepEqual(source.parent, { sessionId: "main", incarnationId: "inc-main" });
    assert.partialDeepStrictEqual(snapshot.turns[0], { sessionId: null, auxiliarySessionId: "aux" });
    const { client } = await f.connect(binding, "memoryUrl");
    const mcp = await client.callTool({ name: "character_affect.appraise", arguments: { candidates: [candidate("aux-only")] } });
    assert.equal((mcp.structuredContent as Record<string, any>).saved.length, 1, JSON.stringify(mcp));
    const relationship = { ...candidate("shared-user"), layer: "relationship", targetType: "user" };
    const child = await cli(f, binding, { candidates: [relationship] });
    assert.equal(child.code, 0, JSON.stringify(child));
    assert.equal(child.value.saved.length, 1);
    assert.deepEqual(f.db.prepare(`SELECT layer,session_id,source_session_id,auxiliary_session_id,source_auxiliary_session_id,character_id
      FROM character_affect_events_v6 ORDER BY layer`).all().map((row) => ({ ...row })), [
      { layer: "relationship", session_id: null, source_session_id: null, auxiliary_session_id: null, source_auxiliary_session_id: "aux", character_id: "character" },
      { layer: "session", session_id: null, source_session_id: null, auxiliary_session_id: "aux", source_auxiliary_session_id: "aux", character_id: "character" },
    ]);
    assert.deepEqual(await context(f, "aux", f.scope("aux").history.source), ["aux-only", "shared-user"]);
    assert.deepEqual(await context(f, "aux"), ["shared-user"]);
    assert.deepEqual(await context(f, "other"), ["shared-user"]);
    assert.deepEqual(await context(f, "main", undefined, "parent-character"), []);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary登録は他owner・history外のsourceTurnとcallerによる保存identity指定をMCPと配布CLIで拒否する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録" }
// fault = "背景scope外のTurnやcallerのidentityを保存根拠として受理する"
// observable = "MCP/CLIの拒否応答と実DBのAffect event件数"
// observation_boundary = "public-boundary"
// scope = "Auxiliary source admission and strict candidate input through both bound public adapters"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "Main登録testではsessionId:nullとauxiliarySessionIdによる実Turn所属判定を通らない"
// @end-test-value
test("Auxiliaryのscope外Turnとcaller identityはMCPとCLIから保存できない", async () => {
  const f = await fixture();
  try {
    f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
      VALUES (2,'main','completed',1,?,?,?)`).run(time, time, time);
    const scopes = [undefined,
      (scope: BackgroundExecutionScope) => ({ ...scope, history: { ...scope.history, throughMessageSeq: 0 } })];
    for (const [index, change] of scopes.entries()) {
      const execution = start(f, change), binding = f.project(execution);
      const { client } = await f.connect(binding, "memoryUrl");
      const input = { candidates: [candidate("rejected", index === 0 ? 2 : 1)] };
      const mcp = await client.callTool({ name: "character_affect.appraise", arguments: input });
      assert.partialDeepStrictEqual(mcp.structuredContent, { error: { code: "invalid_input", effect: "none" } });
      assert.partialDeepStrictEqual((await cli(f, binding, input)).value, { error: { code: "invalid_input", effect: "none" } });
      f.executions.finish(execution);
    }
    const binding = f.project(start(f));
    const { client } = await f.connect(binding, "memoryUrl");
    const forged = { candidates: [{ ...candidate("forged"), sessionId: "main", characterId: "parent-character" }] };
    assert.equal((await client.callTool({ name: "character_affect.appraise", arguments: forged })).isError, true);
    assert.notEqual((await cli(f, binding, forged)).code, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary登録途中の実行失効は確認済みprefixを保持し、失効後の候補と後続CLI登録を保存しない"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録" }
// fault = "失効したadmissionでWorker保存を続ける、確定済みprefixを巻き戻す、または後続候補を試行する"
// observable = "bound CLIのpartial failureとsaved prefix、Worker呼出件数、SQLiteのAuxiliary event列"
// observation_boundary = "public-boundary"
// scope = "bundled CLI and production Auxiliary handler with revocation at the existing Worker mutation boundary"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "Mainのstorage failure testに対しAuxiliary owner付きmutationへ同じ失効admissionが伝播することを確認する"
// @end-test-value
test("Auxiliaryの途中失効はsaved prefixを残し後続writeを止める", async () => {
  const f = await fixture();
  try {
    const execution = start(f), binding = f.project(execution);
    const record = f.memoryWorker.affectStorage.recordEvent.bind(f.memoryWorker.affectStorage);
    let attempted = 0;
    f.memoryWorker.affectStorage.recordEvent = async (event, options) => {
      if (++attempted === 2) f.executions.finish(execution);
      return record(event, options);
    };
    const response = await cli(f, binding, { candidates: [candidate("saved"), candidate("revoked"), candidate("unattempted")] });
    assert.partialDeepStrictEqual(response.value, { error: { code: "partial_failure", effect: "partial", details: { failedCandidateIndex: 1 } } });
    assert.equal(response.value.error.details.saved.length, 1);
    assert.equal(attempted, 2);
    assert.deepEqual(f.db.prepare("SELECT id,target_id,session_id,auxiliary_session_id FROM character_affect_events_v6").all().map((row) => ({ ...row })), [
      { id: response.value.error.details.saved[0].eventId, target_id: "saved", session_id: null, auxiliary_session_id: "aux" },
    ]);
    assert.notEqual((await cli(f, binding, { candidates: [candidate("late")] })).code, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get()!.count, 1);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの次の通常turnは本番assemblyの実metadataと親からtrusted sourceを組み立て、保存済みAuxiliary Affectをforeground Providerへ渡す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "assemblyがAffect contextを接続しないか同名Mainや親Characterへ解決してProviderへ空または別会話のcontextを渡す"
// observable = "背景MCPの保存応答とfake foreground Providerが受け取るcharacterContextのeffective target"
// observation_boundary = "consumer"
// scope = "production Auxiliary runtime assembly and SessionRuntimeService with real Auxiliary metadata, application and DB Worker; foreground conversation writes and Provider are stubs"
// lifecycle = "permanent"
// distinction = "getContext直接呼出では本番assemblyのtrusted Auxiliary source組立てとProvider入力への接続を検出できない"
// @end-test-value
test("Auxiliary本番assemblyは次の通常turnのProviderへ保存済みAffectを渡す", async () => {
  const f = await fixture();
  try {
    f.db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('parent-character','Parent','now','now')").run();
    f.db.prepare("UPDATE sessions_v6 SET character_id = 'parent-character' WHERE id = 'main'").run();
    f.db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES ('aux','inc-same-name','Same-name Main','active','codex',1,'test','on-request','character','{}','now','now','now')`).run();
    const execution = start(f), binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    const saved = await client.callTool({ name: "character_affect.appraise", arguments: { candidates: [candidate("foreground-aux")] } });
    assert.equal((saved.structuredContent as Record<string, any>).saved.length, 1);
    f.executions.finish(execution);
    let runtimeSession: Session = { ...f.sessions.get("aux")!, model: "test", reasoningEffort: "",
      characterRuntimeSnapshot: { characterId: "character", name: "Character", description: "", iconFilePath: "",
        theme: { main: "#123456", sub: "#abcdef" }, definitionMarkdown: "Character", definitionSha256: "fixture",
        definitionByteSize: 9, snapshotAt: time } };
    let live: LiveSessionRunState | null = null;
    const contexts: (CharacterAffectContext | null | undefined)[] = [];
    const adapter: ProviderCodingAdapter = {
      composePrompt() { return { systemBodyText: "system", inputBodyText: "input", logicalPrompt: {
        systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }; },
      async runSessionTurn(input) { contexts.push(input.characterContext); return { threadId: null, assistantText: "foreground answer", usage: null }; },
      async getProviderQuotaTelemetry() { return null; }, async invalidateSessionThread() {}, async invalidateAllSessionThreads() {},
    };
    const catalog = { id: runtimeSession.provider, label: "Fixture", defaultModelId: runtimeSession.model,
      defaultReasoningEffort: runtimeSession.reasoningEffort, models: [{ id: runtimeSession.model, label: "Fixture", reasoningEfforts: [runtimeSession.reasoningEffort] }] };
    const keep = async (session: Session) => { runtimeSession = session; return session; };
    const failures: unknown[] = [];
    const runtime = createAuxiliarySessionRuntime({ owner: { assertActive() {} },
      admission: { runSessionAdmissionExclusive: async (_id, action) => action() },
      auxiliary: { getRuntimeSession: async () => runtimeSession,
        getSession: async (id) => f.auxiliary.getAuxiliarySessionMetadata(id), isAuxiliarySession: async () => true,
        appendRunningInput: keep, appendTerminalSession: keep, checkpointRuntimeMetadata: keep, persistRunningTurnStart: keep },
      parent: { getSession: async (id) => f.worker.stores.session.getSession(id) },
      resolution: { resolveRuntimeSessionForTurn: (session) => session, resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
        resolveProviderCatalog: () => ({ provider: catalog, snapshot: { providers: [catalog] } }) },
      provider: { getProviderCodingAdapter: () => adapter, resetProviderSessionThread: async () => {},
        resolveProviderSession: (session) => session, resolveSessionFolderPath: () => f.directory,
        issueRuntimeBinding: async (session, provider) => f.bindings.issueOrReuse({ actorSessionId: session.id, providerId: provider.id, operationGrants: [] }) },
      memory: { getAppSettings: () => normalizeAppSettings({}), getCharacterContextService: () => f.characterContext,
        onCharacterContextFailure: (_session, error) => { failures.push(error); } },
      turn: { createSessionTurn: (input) => ({ id: 100, ...input }), updateSessionTurn() {} },
      live: { setLiveSessionRun: (_id, state) => { live = state; }, getLiveSessionRun: () => live,
        setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {} },
      interaction: { waitForApprovalDecision: () => "approve", waitForElicitationResponse: () => ({ action: "cancel" }),
        cancelApprovals() {}, cancelElicitations() {}, invalidateProviderSessionThread: async () => {} }, notification() {},
    });
    await runtime.runSessionTurn("aux", { executionOptions: captureSessionExecutionOptions(runtimeSession), userMessage: "Next Auxiliary turn" });
    await runtime.waitForPendingRuns();
    assert.deepEqual(failures, []);
    assert.equal(contexts.length, 1);
    assert.deepEqual(contexts[0]?.affect.effective.map((component) => component.targetId), ["foreground-aux"]);
  } finally { await f.close(); }
});
