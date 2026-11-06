import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { BackgroundProductionRuntime } from "../../src-electron/providers/background-production-runtime.js";
import { BackgroundCallService } from "../../src-electron/providers/background-call-service.js";
import type { BackgroundFailureEvent, BackgroundFailureInput } from "../../src-electron/providers/background-failure.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { backgroundHistoryFixture } from "../helpers/background-history-fixture.js";
import { backgroundMemoryRegistrationHandlers } from "../../src-electron/memory/background-memory-registration.js";
import { registerBackgroundAffect } from "../../src-electron/character/background-affect-registration.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
import { backgroundOperationFailure, classifyBackgroundFailure } from "../../src-electron/providers/background-failure.js";
import { ProviderTurnError } from "../../src-electron/providers/provider-runtime.js";
import { getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { callWithMateMemoryRuntime } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src-electron/platform/memory/memory-runtime-exchange.js";
import { backgroundOperationResult } from "../../src-electron/providers/background-diagnostics.js";

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryの三用途で準備失敗とAgent例外の実原因を秘密除去して一件記録し、成功・通常取消・未設定は記録しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "失敗原因を定型文へ潰す、重複記録する、tokenやpromptを保存する、または正常非実行を失敗にする"
// observable = "ProductionRuntimeのonFailure eventの件数・用途・元会話・原因・権限とrunOnce結果"
// observation_boundary = "consumer"
// scope = "real production preparation, call and binding lifetime with injected catalog/source/Agent"
// lifecycle = "permanent"
// impact = "用途と元会話を特定して背景失敗を調査できないか会話・認証情報が漏れる"
// distinction = "logger単体とcontroller単体は共有prepare/runOnceの結果を専用failure callbackまで観測しない"
// @end-test-value
test("all background purposes and source kinds retain causal diagnostics without credentials or prompt dumps", async () => {
  const f = await backgroundHistoryFixture();
  const events: BackgroundFailureEvent[] = [];
  const settings = normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } } });
  let failCatalog = false, failAgent = false;
  const runtime = new BackgroundProductionRuntime({ executions: f.executions, onFailure: (event) => events.push(event),
    getAppSettings: () => settings,
    getModelCatalog: () => { if (failCatalog) throw new Error("Catalog connection refused token=CATALOG_SECRET");
      return { providers: [{ id: "claude", label: "Claude", defaultModelId: "test", defaultReasoningEffort: "",
        models: [{ id: "test", label: "Test", reasoningEfforts: [] }] }] }; },
    captureSource: async (source) => ({ history: f.scope(source.sessionId).history,
      snapshot: { session: f.sessions.get(source.sessionId)!, ownerIdentity: f.scope(source.sessionId).history.source.ownerIdentity,
        turns: [{ id: 1, sessionId: source.kind === "main" ? source.sessionId : null,
          ...(source.kind === "auxiliary" ? { auxiliarySessionId: source.sessionId } : {}), phase: "completed",
          completedAt: "now", assistantMessageSeq: 0 }] } }),
    resolveAuthority: () => ({ userId: "local-user", characterId: "character", allowedProjectIds: [] }),
    sourceKinds: { "character-memory": ["main", "auxiliary"], "target-memory": ["main", "auxiliary"], affect: ["main", "auxiliary"] },
    runAgent: () => { if (failAgent) throw Object.assign(new Error("Approval rejected authorization=AGENT_SECRET", {
      cause: Object.assign(new Error("Service refused token=CAUSE_SECRET"), { code: "REMOTE_DENIED" }),
    }), { code: "BACKGROUND_APPROVAL_REQUIRED" }); },
  });
  try {
    for (const id of ["main", "aux"]) for (const purpose of ["character-memory", "target-memory", "affect"] as const) {
      settings.backgroundExecutionSettings[purpose] = { selection: { providerId: "claude", modelId: "test", approvalMode: "on-request" } };
      const input = { purpose, source: f.scope(id, purpose).history.source, session: f.sessions.get(id)!, memoryTargets: [] };
      const before = events.length;
      failCatalog = true;
      assert.equal((await runtime.prepare(input)).status, "failed");
      assert.equal(events.length, before + 1);
      assert.equal(events.at(-1)!.code, "BACKGROUND_CATALOG_UNAVAILABLE");
      assert.partialDeepStrictEqual(events.at(-1)!.diagnostic, {
        cause: { message: "Catalog connection refused token=[REDACTED]" },
      });
      failCatalog = false;
      const prepared = await runtime.prepare(input);
      assert.equal(prepared.status, "ready");
      if (prepared.status !== "ready") throw new Error("Expected ready");
      failAgent = true;
      assert.deepEqual(await runtime.calls.runOnce({ ...prepared.call, userInput: "SECRET prompt", onAdmitted() {} }), { kind: "failed", code: "BACKGROUND_APPROVAL_REQUIRED" });
      assert.equal(events.length, before + 2);
      assert.equal(events.at(-1)!.purpose, purpose);
      assert.equal(events.at(-1)!.sourceKind, input.source.kind);
      assert.equal(events.at(-1)!.sourceSessionId, id);
      assert.equal(events.at(-1)!.permissions!.approvalMode, "on-request");
      assert.partialDeepStrictEqual(events.at(-1)!.diagnostic, { code: "BACKGROUND_APPROVAL_REQUIRED",
        message: "Approval rejected authorization=[REDACTED]", cause: { code: "REMOTE_DENIED", message: "Service refused token=[REDACTED]" } });
      assert.match(JSON.stringify(events.at(-1)!.diagnostic), /stack/);
      assert.equal(events.at(-1)!.execution!.executionId, events.at(-1)!.execution!.bindingId);
      assert.ok(events.at(-1)!.execution!.startedAt <= events.at(-1)!.execution!.endedAt);
      failAgent = false;
      assert.deepEqual(await runtime.calls.runOnce({ ...prepared.call, userInput: "", onAdmitted() {} }), { kind: "completed" });
      const cancel = new AbortController(); cancel.abort();
      assert.equal((await runtime.calls.runOnce({ ...prepared.call, context: { ...prepared.call.context, signal: cancel.signal }, userInput: "", onAdmitted() {} })).kind, "canceled");
      settings.backgroundExecutionSettings[purpose] = {};
      assert.equal((await runtime.prepare(input)).status, "not_configured");
      assert.equal(events.length, before + 2);
    }
    assert.equal(JSON.stringify(events).includes("SECRET"), false);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
  } finally { runtime.stop(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "実bound履歴MCP/配布CLIの既知失敗とMCP schema拒否をAgent正常returnでも失敗へ伝え、元の公開応答と他executionを維持する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "tool isErrorを保存対象なしへ読み替えるか、HTTP前schema拒否を見逃すか、他bindingまで終了する"
// observable = "MCP応答/CLI exit、runOnce failed code、failure callback一件、独立bindingのadmission"
// observation_boundary = "public-boundary"
// scope = "actual managed MCP and bundled CLI through HTTP saved-history runtime into execution failure latch"
// lifecycle = "permanent"
// impact = "履歴取得に失敗した背景実行が成功として扱われ、原因が失われる"
// distinction = "Agent mock例外ではtoolが失敗を返した後にAgentが正常終了する実transport経路を確認できない"
// @end-test-value
test("bound MCP and CLI failures survive a normally returning Agent", async () => {
  const f = await backgroundHistoryFixture();
  try {
    const other = f.started("other");
    for (const mode of ["mcp", "cli", "schema", "grant"] as const) {
      const errors: BackgroundFailureInput[] = [];
      const service = new BackgroundCallService({ executions: f.executions, onFailure: (failure) => errors.push(failure),
        runAgent: async (agent) => {
          const binding = f.project({ binding: agent.binding, handle: agent.handle, signal: agent.signal, admission: { state: agent.handle.revocationState } });
          if (mode === "cli") {
            await assert.rejects(promisify(execFile)(process.execPath, [resolve("resources/cli/withmate-session-history.mjs"), "get-message", "--json", '{"seq":99}'],
              { cwd: f.directory, env: f.cliEnv(binding), windowsHide: true }), (error: unknown) => {
              const result = error as { stdout: string; code: number };
              assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).code, "HISTORY_OUT_OF_RANGE"); return true;
            });
          } else {
            const { client, transport } = await f.connect(binding);
            if (mode === "grant") assert.equal((await f.request(binding, binding.managedMcp!.sessionHistoryUrl!, "memory.append", transport.sessionId)).status, 403);
            else if (mode === "schema") {
              const result = await client.callTool({ name: "session_history.get_message", arguments: { seq: "invalid" } });
              assert.equal(result.isError, true);
            } else {
              const result = await client.callTool({ name: "session_history.get_message", arguments: { seq: 99 } });
              assert.equal(result.isError, true); assert.equal((result.structuredContent as { code: string }).code, "HISTORY_OUT_OF_RANGE");
            }
          }
        } });
      const result = await service.runOnce({ context: { session: f.sessions.get("main")!, actorSessionId: "main", authoritySnapshot: { characterId: "character" },
        scope: f.scope(), operationGrants: ["session_history.route.get_message"] }, selection: { providerId: "claude", modelId: "test" }, userInput: "", onAdmitted() {} });
      assert.deepEqual(result, { kind: "failed", code: mode === "schema" ? "BACKGROUND_OPERATION_FAILED" : mode === "grant" ? "SESSION_BINDING_FORBIDDEN" : "HISTORY_OUT_OF_RANGE" });
      assert.equal(errors.length, 1);
      const operations = errors[0]!.execution!.operations.filter((operation) => operation.boundary === (mode === "cli" ? "history" : "mcp"));
      assert.equal(operations.length, 2, mode);
      assert.equal(operations[0]!.phase, "request");
      assert.equal(operations[1]!.phase, "response");
      assert.equal(operations[0]!.requestId, operations[1]!.requestId);
      assert.equal(operations[1]!.outcome, "failure");
      assert.equal(operations[1]!.boundary, mode === "cli" ? "history" : "mcp");
      if (mode === "schema") {
        assert.equal(operations[0]!.toolName, "session_history.get_message");
        const diagnostic = JSON.stringify(operations[1]!.failure!.diagnostic);
        assert.match(diagnostic, /seq/); assert.match(diagnostic, /number/); assert.match(diagnostic, /string/);
      }
      assert.equal(other.admission.isCurrent!(), true);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "三用途のMain/Auxiliary登録は拒否前後と途中保存を保持し、MCP/CLIの実保存例外の原因と保存IDを失敗診断へ残す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "登録拒否を成功にするか保存を取消すか、公開エラーへの変換で保存例外を失うか秘密をログに残す"
// observable = "MCP/CLIの公開応答、runOnce失敗code、一件のfailure eventの境界別操作列・保存ID・DB実原因、SQLite保存件数"
// observation_boundary = "public-boundary"
// scope = "all background registration handlers through managed MCP, HTTP service and SQLite Worker"
// lifecycle = "permanent"
// impact = "背景登録失敗が見えないか、既に記録したMemory/Affectが失われる"
// distinction = "履歴失敗testは用途別の書込応答と失敗後の実保存結果を観測しない"
// @end-test-value
test("registration failures preserve earlier saved Memory and Affect for both source kinds", async () => {
  const f = await backgroundHistoryFixture(undefined, { ...backgroundMemoryRegistrationHandlers, affect: registerBackgroundAffect }, undefined,
    { "character-memory": ["main", "auxiliary"], "target-memory": ["main", "auxiliary"], affect: ["main", "auxiliary"] });
  const time = "2026-11-01T01:00:00.000Z";
  try {
    f.db.prepare("INSERT INTO auxiliary_session_messages(auxiliary_session_id,seq,role,body,created_at) VALUES ('aux',1,'assistant',?,'now')").run('{"text":"answer"}');
    for (const [id, sessionId, auxiliaryId] of [[1, "main", null], [2, null, "aux"]] as const) {
      f.db.prepare("INSERT INTO session_turns_v6(id,session_id,auxiliary_session_id,phase,assistant_message_seq,started_at,completed_at,updated_at) VALUES (?,?,?,'completed',1,?,?,?)")
        .run(id, sessionId, auxiliaryId, time, time, time);
    }
    let savedMemory = 0, savedAffect = 0;
    for (const id of ["main", "aux"]) for (const purpose of ["character-memory", "target-memory", "affect"] as const) {
      const errors: BackgroundFailureInput[] = [];
      const key = `${id}-${purpose}`;
      let savedResponse: Record<string, unknown> | undefined;
      let rejectedResponse: Record<string, unknown> | undefined;
      let returnedNormally = false;
      const storageResponses: Record<string, unknown>[] = [];
      const service = new BackgroundCallService({ executions: f.executions, onFailure: (error) => errors.push(error), runAgent: async (agent) => {
        const binding = f.project({ binding: agent.binding, handle: agent.handle, signal: agent.signal, admission: { state: agent.handle.revocationState } });
        const { client } = await f.connect(binding, "memoryUrl");
        const tool = purpose === "affect" ? "character_affect.appraise" : purpose === "character-memory" ? "character_memory.append_episode" : "memory.append";
        const args = purpose === "affect" ? { candidates: [{ sourceTurnId: id === "main" ? 1 : 2, layer: "session", targetType: "bug", targetId: key,
          family: "interest", value: { label: "interest", valence: 0.4 }, intensity: 0.6, reason: "Fact", evidence: "Saved answer" }] }
          : purpose === "character-memory" ? { idempotencyKey: key, episode: { title: key, body: key, preview: key, observedFact: "Saved answer" } }
          : { target: { kind: "user-global" }, kind: "note", title: key, body: key, preview: key, tags: [], idempotencyKey: key };
        savedResponse = await client.callTool({ name: tool, arguments: args });
        const rejected = purpose === "affect" ? { candidates: [{ ...args.candidates![0], sourceTurnId: 999 }] }
          : purpose === "character-memory" ? { idempotencyKey: `${key}-bad`, episode: { ...args.episode, observedFact: "" } }
          : { ...args, target: { kind: "project", project: { type: "id", id: "ungranted" } } };
        rejectedResponse = await client.callTool({ name: tool, arguments: rejected });
        const late = purpose === "affect" ? args : { ...args, idempotencyKey: `${key}-late` };
        const lateResponse = await client.callTool({ name: tool, arguments: late });
        assert.equal(lateResponse.isError, undefined);
        for (const transport of ["mcp", "cli"] as const) {
          const storageError = Object.assign(new Error("database is locked token=STORE_SECRET", {
            cause: new Error("The storage write was rejected credential=CAUSE_SECRET"),
          }), { code: "SQLITE_BUSY" });
          const originalAppend = f.memory.append;
          const originalRecord = f.memoryWorker.affectStorage.recordEvent;
          let writes = 0;
          if (purpose === "affect") {
            f.memoryWorker.affectStorage.recordEvent = (...input) => ++writes === 2
              ? Promise.reject(storageError) : originalRecord(...input);
          } else f.memory.append = async () => { throw storageError; };
          const storageArgs = purpose === "affect" ? { candidates: [0, 1].map((index) => ({ ...args.candidates![0], targetId: `${key}-${transport}-${index}` })) }
            : { ...args, idempotencyKey: `${key}-${transport}-storage` };
          try {
            if (transport === "mcp") {
              const response = await client.callTool({ name: tool, arguments: storageArgs });
              assert.equal(response.isError, true);
              storageResponses.push(response.structuredContent as Record<string, unknown>);
            } else {
              const command = purpose === "affect" ? "affect-appraise" : purpose === "character-memory" ? "character-memory-append-episode" : "append";
              await assert.rejects(promisify(execFile)(process.execPath, [resolve("resources/cli/withmate-memory.mjs"), command, "--json", JSON.stringify(storageArgs)],
                { cwd: f.directory, env: f.cliEnv(binding), windowsHide: true }), (error: unknown) => {
                const response = error as { code: number; stdout: string };
                assert.equal(typeof response.code, "number");
                storageResponses.push(JSON.parse(response.stdout));
                return true;
              });
            }
          } finally {
            f.memory.append = originalAppend;
            f.memoryWorker.affectStorage.recordEvent = originalRecord;
          }
        }
        returnedNormally = true;
      } });
      const initial = f.scope(id, purpose);
      const result = await service.runOnce({ context: { session: f.sessions.get(id)!, actorSessionId: id,
        authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
        scope: { ...initial, history: { ...initial.history, throughMessageSeq: 1 },
          memoryTargets: [{ owner: "user", scope: "global" }, { owner: "character", scope: "character", character: { type: "id", id: "character" } }] },
        operationGrants: [BACKGROUND_REGISTRATION_OPERATIONS[purpose].operation] }, selection: { providerId: "claude", modelId: "test" }, userInput: "", onAdmitted() {} });
      assert.equal(returnedNormally, true);
      assert.ok(savedResponse); assert.equal(savedResponse.isError, undefined);
      assert.ok(rejectedResponse); assert.equal(rejectedResponse.isError, true);
      assert.deepEqual(result, { kind: "failed", code: purpose === "target-memory" ? "MEMORY_INVALID_FIELD"
        : purpose === "character-memory" ? "BACKGROUND_OPERATION_FAILED" : "invalid_input" }, `${id}/${purpose}`);
      assert.equal(errors.length, 1);
      const operations = errors[0]!.execution!.operations;
      assert.deepEqual(operations.map((operation) => operation.sequence), operations.map((_, index) => index + 1));
      const responses = operations.filter((operation) => operation.phase === "response" && operation.boundary === "mcp");
      assert.deepEqual(responses.slice(0, 3).map((operation) => operation.outcome), ["success", "failure", "success"]);
      assert.ok(operations.every((operation) => operation.boundary === "registration" || operation.boundary === "mcp"));
      for (const response of [responses[0]!, responses[2]!]) assert.match(JSON.stringify(response.result), purpose === "affect" ? /eventId/ : /"id"/);
      const storageFailures = operations.filter((operation) => operation.boundary === "registration" && operation.failure
        && JSON.stringify(operation.failure.diagnostic).includes("SQLITE_BUSY"));
      assert.equal(storageFailures.length, 2, `${id}/${purpose}`);
      for (const failure of storageFailures) {
        assert.match(JSON.stringify(failure.failure!.diagnostic), /database is locked token=\[REDACTED\]/);
        assert.match(JSON.stringify(failure.failure!.diagnostic), /storage write was rejected credential=\[REDACTED\]/);
        if (purpose === "affect") assert.match(JSON.stringify(failure.result), /eventId/);
      }
      assert.equal(storageResponses.length, 2);
      for (const response of storageResponses) {
        assert.equal(JSON.stringify(response).includes("SQLITE_BUSY"), false);
        assert.equal(JSON.stringify(response).includes("database is locked"), false);
      }
      assert.equal(JSON.stringify(errors).includes("Saved answer"), false);
      assert.equal(JSON.stringify(errors).includes("STORE_SECRET"), false);
      assert.equal(JSON.stringify(errors).includes("CAUSE_SECRET"), false);
      if (purpose === "affect") savedAffect += 4; else savedMemory += 2;
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_entries_v6").get()!.n, savedMemory);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM character_affect_events_v6").get()!.n, savedAffect);
      assert.equal(f.bindings.getActiveBindingCount(), 0);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Affectの候補別拒否と部分保存IDを保持し、Provider実原因は診断項目だけを秘密除去して残す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "Affectのrejectedや実原因を捨てるか、Providerのtokenや会話partialResultを転載する"
// observable = "failure projectionのcode・候補別diagnostic・部分保存IDと、拒否のない0件結果がfailureを返さないこと"
// observation_boundary = "component-behavior"
// scope = "trusted operation-result and app-owned ProviderTurnError reason projection"
// lifecycle = "permanent"
// impact = "部分拒否が正常な保存対象なしに変わるかProvider秘密情報がログへ漏れる"
// distinction = "公開transportのdomain validatorでは生成不能なrejected envelopeと有限Provider理由の全値を小さい入力で確認する"
// @end-test-value
test("safe projection distinguishes candidate rejection and finite provider reasons", () => {
  for (const saved of [[], [{ id: "saved-prefix" }]]) {
    assert.deepEqual(backgroundOperationFailure({ saved, rejected: [{ code: "invalid_input", message: "Expected number", details: { path: ["candidates", 0], expected: "number" } }] }, "registration"),
      { code: "invalid_input", reason: "The bound Character operation failed.", stage: "registration",
        diagnostic: { errors: [{ code: "invalid_input", message: "Expected number", details: { path: ["candidates", 0], expected: "number" } }] } });
  }
  const rejected = backgroundOperationFailure({ rejected: [
    { code: "invalid_input", message: "Expected number", candidateIndex: 0 },
    { code: "authority_denied", message: "Target not permitted", candidateIndex: 1 },
  ] }, "registration");
  assert.partialDeepStrictEqual(rejected?.diagnostic, { errors: [
    { code: "invalid_input", message: "Expected number", candidateIndex: 0 },
    { code: "authority_denied", message: "Target not permitted", candidateIndex: 1 },
  ] });
  assert.deepEqual(backgroundOperationResult({ error: { details: { saved: [{ eventId: "saved-event", memoryEntryId: "saved-memory" }], body: "PRIVATE" } } }),
    { error: { details: { saved: [{ eventId: "saved-event", memoryEntryId: "saved-memory" }] } } });
  assert.deepEqual(classifyBackgroundFailure({ diagnostic: { message: "Denied token=PRIVATE", prompt: "PRIVATE", arguments: { body: "PRIVATE" } } }, "agent").diagnostic,
    { message: "Denied token=[REDACTED]" });
  assert.equal(backgroundOperationFailure({ saved: [], rejected: [] }, "registration"), undefined);
  for (const [reason, suffix] of [["usage_limit", "USAGE_LIMIT"], ["auth", "AUTH"], ["network", "NETWORK"], ["provider_unavailable", "UNAVAILABLE"]] as const) {
    const failure = classifyBackgroundFailure(new ProviderTurnError("Connection refused token=SECRET", { threadId: "", assistantText: "SECRET", usage: null }, false, reason), "agent");
    assert.equal(failure.code, `BACKGROUND_PROVIDER_${suffix}`); assert.equal(failure.reason.includes("SECRET"), false);
    assert.partialDeepStrictEqual(failure.diagnostic, { name: "ProviderTurnError", message: "Connection refused token=[REDACTED]", reason });
    assert.equal(JSON.stringify(failure).includes("SECRET"), false);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryの有効背景bindingに対する実Memory/履歴CLIのoperation拒否は公開応答を維持し、Agent正常return後も失敗event一件とfailedへ届く"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#失敗の記録" }
// fault = "operation grant拒否で実行への帰属も捨ててcompletedにする、拒否を許可へ変える、または別executionも失敗にする"
// observable = "Agent外のCLI exit/code/effect、正常return到達、runOnce code、共通failure event一件、保存0件、他bindingのadmissionとfailure"
// observation_boundary = "public-boundary"
// scope = "bundled Memory CLI and session-history CLI through real HTTP into production failure reporting"
// lifecycle = "permanent"
// impact = "既知の用途外操作拒否が成功に見え専用失敗ログの原因を失うか、意図しない保存を許す"
// distinction = "MCP hostのgrant検査とAgent例外testではHTTP operation resolveが拒否した配布CLIの正常return経路を検出できない"
// @end-test-value
test("CLI operation denials reach the background failure boundary without granting the operation", async () => {
  const f = await backgroundHistoryFixture(undefined, { affect: registerBackgroundAffect });
  const originalSessions = structuredClone([...f.sessions]);
  try {
    const other = f.started("other");
    for (const sourceId of ["main", "aux"]) for (const mode of ["memory", "history"] as const) {
      const events: BackgroundFailureEvent[] = [];
      let response: { exit: number; value: { error?: { code: string; effect: string }; code?: string; effect?: string } } | undefined;
      let returnedNormally = false;
      const runtime = new BackgroundProductionRuntime({ executions: f.executions, onFailure: (event) => events.push(event),
        getAppSettings: () => normalizeAppSettings({}), getModelCatalog: () => ({ providers: [] }),
        captureSource: async () => null, resolveAuthority: () => null, sourceKinds: {},
        runAgent: async (agent) => {
          const binding = f.project({ binding: agent.binding, handle: agent.handle, signal: agent.signal, admission: { state: agent.handle.revocationState } });
          const cli = mode === "memory" ? "withmate-memory.mjs" : "withmate-session-history.mjs";
          const command = mode === "memory" ? "append" : "get-message";
          const body = mode === "memory" ? { target: { kind: "user-global" }, kind: "note", title: "Denied", body: "Denied",
            preview: "Denied", tags: [], idempotencyKey: `${sourceId}-denied` } : { seq: 0 };
          response = await promisify(execFile)(process.execPath, [resolve("resources/cli", cli), command, "--json", JSON.stringify(body)],
            { cwd: f.directory, env: f.cliEnv(binding), windowsHide: true, timeout: 15_000 })
            .then(({ stdout }) => ({ exit: 0, value: JSON.parse(stdout) }), (error: unknown) => {
              const child = error as { code: number; stdout: string };
              if (typeof child.code !== "number" || typeof child.stdout !== "string") throw error;
              return { exit: child.code, value: JSON.parse(child.stdout) };
            });
          returnedNormally = true;
        } });
      const grants = [...getSessionHistoryAgentRuntimeOperations(), ...getBackgroundMemoryReadOperations(), BACKGROUND_REGISTRATION_OPERATIONS.affect.operation]
        .filter((operation) => mode !== "history" || operation !== "session_history.route.get_message");
      const result = await runtime.calls.runOnce({ context: { session: f.sessions.get(sourceId)!, actorSessionId: sourceId,
        authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] }, scope: f.scope(sourceId), operationGrants: grants },
        selection: { providerId: "claude", modelId: "test" }, userInput: "", onAdmitted() {} });
      assert.equal(returnedNormally, true); assert.ok(response);
      assert.equal(response.exit, mode === "memory" ? 3 : 1);
      const code = mode === "memory" ? "MEMORY_FORBIDDEN" : "SESSION_BINDING_FORBIDDEN";
      assert.equal(response.value.error?.code ?? response.value.code, code);
      assert.equal(response.value.error?.effect ?? response.value.effect, "none");
      assert.deepEqual(result, { kind: "failed", code });
      assert.equal(events.length, 1);
      assert.partialDeepStrictEqual(events[0], { code, stage: mode === "memory" ? "registration" : "history", purpose: "affect",
        sourceKind: sourceId === "main" ? "main" : "auxiliary", sourceSessionId: sourceId });
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_entries_v6").get()!.n, 0);
      assert.equal(other.admission.isCurrent!(), true); assert.equal(other.failure, undefined);
      assert.equal(f.bindings.getActiveBindingCount(), 1);
    }
    assert.deepEqual([...f.sessions], originalSessions);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Memory/履歴HTTPの拒否は不明bindingや欠落・別実行のturn capabilityを有効な背景実行の失敗へ帰属させない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#失敗の記録" }
// fault = "操作拒否を記録するためbinding referenceだけを信用し他実行の失敗を作る"
// observable = "実HTTP拒否応答、Agent正常return後のcompletedとfailure件数0、他実行のadmissionとfailure"
// observation_boundary = "public-boundary"
// scope = "real HTTP Memory and history exchange with unknown reference or invalid background turn identity"
// lifecycle = "permanent"
// impact = "不正な呼出しが有効な背景処理へ誤った失敗記録を残す"
// distinction = "CLI正常identityの拒否testでは診断帰属のturn照合漏れを検出できない"
// @end-test-value
test("HTTP denial attribution requires the matching active background binding and turn", async () => {
  const f = await backgroundHistoryFixture();
  try {
    const other = f.started("other");
    for (const mode of ["memory", "history"] as const) for (const invalid of ["reference", "missing-turn", "other-turn"] as const) {
      const errors: unknown[] = [];
      let response: { status: number; value: unknown } | undefined;
      let returnedNormally = false;
      const calls = new BackgroundCallService({ executions: f.executions, onFailure: (error) => errors.push(error), runAgent: async (agent) => {
        response = await callWithMateMemoryRuntime(f.connection, { method: "POST", path: mode === "memory" ? "/v1/append" : "/v1/session-history/get-message",
          body: mode === "memory" ? { target: { kind: "user-global" }, kind: "note", title: "Denied", body: "Denied", preview: "Denied", tags: [] } : { seq: 0 } },
          { signal: agent.signal, ...(mode === "history" ? { exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } : {}),
            bindingReference: invalid === "reference" ? "unknown-reference" : agent.binding.bindingReference,
            turnCapability: invalid === "missing-turn" ? undefined : invalid === "other-turn" ? other.handle.capability : agent.handle.capability });
        returnedNormally = true;
      } });
      const result = await calls.runOnce({ context: { session: f.sessions.get("main")!, actorSessionId: "main",
        authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] }, scope: f.scope(), operationGrants: [] },
        selection: { providerId: "claude", modelId: "test" }, userInput: "", onAdmitted() {} });
      assert.equal(returnedNormally, true); assert.ok(response);
      assert.partialDeepStrictEqual(response, mode === "memory"
        ? { status: 403, value: { error: { code: "MEMORY_FORBIDDEN", effect: "none" } } }
        : { status: invalid === "reference" ? 401 : 403, value: { ok: false,
          code: invalid === "reference" ? "SESSION_BINDING_INVALID" : "SESSION_BINDING_FORBIDDEN", effect: "none" } });
      assert.deepEqual(result, { kind: "completed" }); assert.equal(errors.length, 0);
      assert.equal(other.admission.isCurrent!(), true); assert.equal(other.failure, undefined);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_entries_v6").get()!.n, 0);
    }
  } finally { await f.close(); }
});
