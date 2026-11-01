import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { SessionHistoryRuntimeService } from "../../src-electron/session-history/session-history-runtime-service.js";
import {
  getSessionHistoryAgentRuntimeOperations,
  type SessionHistoryReadInput,
  type SessionHistoryReadScope,
  type SessionHistoryResult,
} from "../../src-shared/session-history/session-history-contract.js";

const scope: SessionHistoryReadScope = { source: { kind: "main", sessionId: "source", incarnationId: "incarnation" }, window: { fromSeq: 2, toSeq: 9 } };

function fixture(read?: (input: SessionHistoryReadInput) => Promise<SessionHistoryResult>) {
  const reads: SessionHistoryReadInput[] = [];
  const registry = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const runtime = new SessionHistoryRuntimeService({
    read: read ? async (input) => { reads.push(input); return read(input); } : async (input) => { reads.push(input); return { ok: true, items: [] }; },
    bindingRegistry: registry, providerAgentRuntimeTurns: turns,
  });
  const issue = (authoritySnapshot: Record<string, unknown>, operationGrants = getSessionHistoryAgentRuntimeOperations(), actorSessionId = "background-1") =>
    registry.issueOrReuse({ actorSessionId, providerId: "codex", authoritySnapshot, operationGrants });
  const request = (binding: { bindingReference: string }, turnCapability: string | undefined, body: unknown = {}, path = "/v1/session-history/list-messages") =>
    ({ method: "POST" as const, path, transport: "mcp" as const, bindingReference: binding.bindingReference, turnCapability, body });
  return { reads, registry, turns, runtime, issue, request };
}

// @test-value v2
// kind = "security"
// claim = "履歴readは履歴grantと有効なscope・実行handleを持つbindingだけに許可し、scopeは引数ではなくbindingから決める"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/908" }
// fault = "履歴grantのない通常turnのbinding、scopeなし、引数でのsource指定、終了・失効した実行から履歴を読めてしまう"
// observable = "route応答のstatus/codeとstorageへ渡されたinputおよび読取件数"
// observation_boundary = "public-boundary"
// scope = "session-history-runtime"
// lifecycle = "permanent"
// impact = "任意の会話や範囲の履歴が背景Providerへ渡ることを防ぐ"
// distinction = "schemaだけでは動的なbinding失効とturn終了、grantの有無を検出できない"
// @end-test-value
test("履歴readはbindingのscopeと有効な実行だけで認可し、引数のsource指定と失効を拒否する", async () => {
  const f = fixture();
  const binding = f.issue({ sessionHistoryScope: scope });
  const turn = f.turns.begin({ actorSessionId: "background-1", providerId: "codex" });
  const response = await f.runtime.route(f.request(binding, turn.capability, { limit: 5 }));
  assert.equal(response?.status, 200);
  assert.deepEqual(f.reads, [{ scope, operation: "list_messages", request: { limit: 5 } }]);

  assert.equal((await f.runtime.route(f.request(binding, turn.capability, { sessionId: "other" })))?.status, 400);
  assert.equal((await f.runtime.route(f.request(binding, undefined)))?.status, 401);
  assert.equal((await f.runtime.route({ ...f.request(binding, turn.capability), bindingReference: "unknown" }))?.status, 401);
  assert.equal((await f.runtime.route({ ...f.request(binding, turn.capability), method: "GET" as never }))?.status, 405);
  assert.equal(f.reads.length, 1);

  const normalTurn = f.issue({ sessionHistoryScope: scope }, ["session_graph.route.recent"], "normal-1");
  const normalHandle = f.turns.begin({ actorSessionId: "normal-1", providerId: "codex" });
  assert.equal((await f.runtime.route(f.request(normalTurn, normalHandle.capability)))?.status, 403);
  const noScope = f.issue({}, undefined, "no-scope-1");
  const scopeHandle = f.turns.begin({ actorSessionId: "no-scope-1", providerId: "codex" });
  const missingScope = await f.runtime.route(f.request(noScope, scopeHandle.capability));
  assert.deepEqual([missingScope?.status, (missingScope?.value as { code: string }).code], [403, "HISTORY_SCOPE_INVALID"]);
  f.turns.end(turn);
  const ended = await f.runtime.route(f.request(binding, turn.capability));
  assert.deepEqual([ended?.status, (ended?.value as { code: string }).code], [401, "HISTORY_EXECUTION_INACTIVE"]);
  assert.equal(f.reads.length, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "読取中に実行が取り消された場合は結果を返さず、storageの失敗・保存状態の失敗は空の成功にせず別のcodeで返す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/908" }
// fault = "取消後に読取結果を返す、またはstorage失敗や未保存を成功として返す"
// observable = "route応答のstatusとvalue.code/ok"
// observation_boundary = "public-boundary"
// scope = "session-history-runtime"
// lifecycle = "permanent"
// impact = "取り消された背景処理が履歴を受け取ることや失敗が成功扱いになることを防ぐ"
// distinction = "静的checkでは読取中の取消と失敗のcode対応を検出できない"
// @end-test-value
test("読取中の取消はdiscardし、storage失敗と保存状態の失敗を成功にしない", async () => {
  let release: (() => void) | undefined;
  const f = fixture(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { ok: true, items: [] }; });
  const binding = f.issue({ sessionHistoryScope: scope });
  const turn = f.turns.begin({ actorSessionId: "background-1", providerId: "codex" });
  const pending = f.runtime.route(f.request(binding, turn.capability));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.turns.end(turn);
  release();
  const cancelled = await pending;
  assert.deepEqual([cancelled?.status, cancelled?.value], [401, { ok: false, code: "HISTORY_EXECUTION_INACTIVE", message: "The background execution ended before the history was returned.", effect: "none" }]);

  const failing = fixture(async () => { throw new Error("database path C:/secret/app.db"); });
  const failingBinding = failing.issue({ sessionHistoryScope: scope });
  const failingTurn = failing.turns.begin({ actorSessionId: "background-1", providerId: "codex" });
  const failed = await failing.runtime.route(failing.request(failingBinding, failingTurn.capability));
  assert.deepEqual([failed?.status, (failed?.value as { code: string }).code, JSON.stringify(failed?.value).includes("secret")], [500, "HISTORY_READ_FAILED", false]);

  const missing = fixture(async () => ({ ok: false, code: "HISTORY_NOT_SAVED", message: "none", effect: "none" }));
  const missingBinding = missing.issue({ sessionHistoryScope: scope });
  const missingTurn = missing.turns.begin({ actorSessionId: "background-1", providerId: "codex" });
  const absent = await missing.runtime.route(missing.request(missingBinding, missingTurn.capability, { seq: 3 }, "/v1/session-history/get-message"));
  assert.deepEqual([absent?.status, (absent?.value as { ok: boolean }).ok], [404, false]);
});
