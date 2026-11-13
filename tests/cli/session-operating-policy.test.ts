import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionCli } from "../../src-cli/session/withmate-session.js";
import { createWithMateSessionMcpServer } from "../../src-electron/platform/mcp/withmate-session-mcp.js";
import type { callWithMateMemoryRuntime, WithMateMemoryRuntimeConnection } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionOperatingPolicyService } from "../../src-electron/session/session-operating-policy-service.js";
import { resolveRelatedSessions } from "../../src-electron/session/session-relationship-resolver.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { OPERATING_POLICY_PROVIDERS, type SelectionPolicy } from "../../src-shared/session/session-operating-policy.js";
import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";

const connection: WithMateMemoryRuntimeConnection = {
  api: { baseUrl: "http://127.0.0.1:7777", apiSecret: "secret", applicationInstanceId: "instance", runtimeGenerationId: "generation", runtimeInstanceId: "generation" },
  credential: { adapter: "mcp", adapterSecret: "adapter" },
};
const policy: SelectionPolicy = {
  selectionCriteria: "機械的変更は軽量モデル、契約判断は高推論モデル。Roleだけで固定しない。",
  executionGuidelines: "Depthは不確実性で選ぶ。ApprovalとSandboxは依頼の許可範囲に従う。",
  contractRoutes: [
    { name: "OpenCode free", provider: "opencode", nativeProviderId: "opencode", modelId: "free-model", conditions: "契約上無料と確認できる場合だけ使う。catalog掲載だけでは判断しない。" },
    { name: "Codex subscription", provider: "codex", conditions: "契約枠の観測結果と取得時刻を確認する。" },
    { name: "OpenAI metered", provider: "opencode", nativeProviderId: "openai", modelId: "paid-model", conditions: "ユーザーが課金経路を許可した場合のみ。" },
  ],
};
const rule = { categoryPath: "Electron", repositoryName: "WithMate", layout: "{repository}/{branch}" };
const exec = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-policy-"));
  const options = { dbPath: join(directory, "withmate-v6.db"), userDataPath: directory,
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url), workerOptions: { execArgv: ["--import", "tsx"] } };
  let bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  const quotas = new Map<string, ProviderQuotaTelemetry>();
  const bindings = new AgentRuntimeBindingRegistry(), turns = new ProviderAgentRuntimeTurnCoordinator();
  const unused = async (): Promise<never> => { throw new Error("Unexpected operation"); };
  const operating = new SessionOperatingPolicyService({ getStore: () => bundle.stores.settings, getQuota: (id) => quotas.get(id) ?? null });
  const application = new SessionManagementApplication({
    listSessions: async () => resolveRelatedSessions(await bundle.stores.session.listSessionSummaries(), []),
    operatingPolicy: (actor, operation, request, current) => operating.execute(operation, request, actor.workspacePath, current),
    currentTurn: unused, crewFolder: unused, directories: unused, updateMetadata: unused, enqueue: unused,
    getReceipt: unused, cancelReceipt: unused, stopTurn: unused, steer: unused, readExecution: unused, createChild: unused, catalog: unused, coordinate: unused,
  });
  const runtime = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
  const runtimeCall: typeof callWithMateMemoryRuntime = async (_connection, operation, bound) => {
    const response = await runtime.route({ ...operation, transport: "mcp", bindingReference: bound.bindingReference, turnCapability: bound.turnCapability });
    assert.ok(response);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, value: response.value };
  };
  const cleanups: (() => Promise<void>)[] = [];
  let nextActor = 0;
  async function endpoint(provider: string, workspacePath = directory) {
    const session = await bundle.stores.session.insertSession(buildNewSession({
      id: `actor-${nextActor++}`, taskTitle: "policy", workspaceLabel: "Workspace", workspacePath, branch: "main",
      characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" },
      provider, model: "saved-model", reasoningEffort: "high", approvalMode: "on-request", sessionRole: "overall-coordinator",
    }));
    const binding = bindings.issueOrReuse({ actorSessionId: session.id, providerId: provider,
      authoritySnapshot: { sessionIdentity: { kind: "main", sessionId: session.id, incarnationId: getSessionIncarnationId(session) } }, operationGrants: getSessionAgentRuntimeOperations() });
    const turn = turns.begin({ actorSessionId: session.id, providerId: provider });
    const env = { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference, WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability };
    const server = createWithMateSessionMcpServer({ env, connection, runtimeCall });
    const client = new Client({ name: "operating-policy", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    cleanups.push(async () => { await client.close(); await server.close(); turns.end(turn); });
    return { session, end: () => turns.end(turn), async call(transport: "cli" | "mcp", operation: string, body: Record<string, unknown> = {}) {
      if (transport === "mcp") {
        const result = await client.callTool({ name: `session.${operation}`, arguments: body });
        return (result.structuredContent ?? result) as Record<string, unknown>;
      }
      let output = "";
      const exit = await runWithMateSessionCli([operation.replaceAll("_", "-"), "--json", JSON.stringify(body)], { env, connection, runtimeCall,
        stdout: { write: (text) => { output += String(text); return true; } }, stderr: { write: () => true } });
      return output ? JSON.parse(output) as Record<string, unknown> : { exit };
    } };
  }
  const git = async (path: string, ...args: string[]) => (await exec("git", ["-c", `core.hooksPath=${join(directory, "no-hooks")}`, "-C", path, ...args], { windowsHide: true })).stdout;
  return { directory, endpoint, quotas, git, get store() { return bundle.stores.settings; }, get sessions() { return bundle.stores.session; },
    async reopen() { await bundle.client.close(); bundle = createV6StorageWorkerBundle(options); await bundle.initialize(); },
    async close() { for (const cleanup of cleanups) await cleanup(); await bundle.client.close(); await rm(directory, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "4ProviderのMCPとbound CLIは同じ選定方針を登録・更新・再起動後取得・解除し、Session設定を変更しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/926" }
// fault = "入口やProviderごとに別の方針を保存する、再起動で失う、取得や方針変更をSession実行設定へ適用する"
// observable = "両入口のpolicy本文とnull、再起動後の保存値、保存Sessionの実行設定"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→runtime→application→実Storage Worker。HTTP交換のみfixture"
// lifecycle = "permanent"
// distinction = "schemaや配線fixtureでは同じDBへの保存・再起動・Sessionからの独立を観測できない"
// @end-test-value
test("selection policy is shared across Providers, MCP and CLI without applying execution settings", async () => {
  const f = await fixture();
  try {
    const endpoints = await Promise.all(OPERATING_POLICY_PROVIDERS.map((provider) => f.endpoint(provider)));
    assert.deepEqual(await endpoints[0].call("mcp", "get_selection_policy"), { ok: true, policy: null });
    for (const endpoint of endpoints) {
      assert.deepEqual(await endpoint.call("cli", "set_selection_policy", { policy }), { ok: true, policy });
      for (const reader of endpoints) assert.deepEqual((await reader.call("mcp", "get_selection_policy")).policy, policy);
      const updated = { ...policy, executionGuidelines: "不確実な契約判断には深い推論。それ以外は案件次第。" };
      assert.deepEqual((await endpoint.call("mcp", "set_selection_policy", { policy: updated })).policy, updated);
      await f.reopen();
      assert.deepEqual((await endpoint.call("cli", "get_selection_policy")).policy, updated);
      const saved = (await f.sessions.getSession(endpoint.session.id))!;
      for (const key of ["provider", "model", "reasoningEffort", "approvalMode", "codexSandboxMode"] as const) assert.equal(saved[key], endpoint.session[key]);
      assert.deepEqual(await endpoint.call("mcp", "set_selection_policy", { policy: null }), { ok: true, policy: null });
      assert.deepEqual(await endpoint.call("cli", "get_selection_policy"), { ok: true, policy: null });
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "quota照会は既存観測の未取得・失敗・未対応・古い取得時刻と数値を両入口で保持し、選定方針を書き換えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/926" }
// fault = "nullを残量無制限へ置換する、失敗をreadyへ変える、古い観測の取得時刻を更新する、観測を設定として保存する"
// observable = "MCP/CLIのquota telemetry全体、供給cacheの不変snapshot、保存policy"
// observation_boundary = "public-boundary"
// scope = "公開両入口からruntime/serviceを通す。既存quota cacheの供給値はfixture"
// lifecycle = "permanent"
// impact = "利用枠や課金経路を誤って選ぶ"
// distinction = "型検査は未知や古い観測値が読取結果で維持されることを保証しない"
// @end-test-value
test("quota reads retain unknown, stale, unsupported and observed data", async () => {
  const f = await fixture();
  try {
    const endpoint = await f.endpoint("codex");
    await endpoint.call("cli", "set_selection_policy", { policy });
    f.quotas.set("copilot", { provider: "copilot", updatedAt: "2026-01-01T00:00:00.000Z", snapshots: [{ quotaKey: "premium", entitlementRequests: 100, usedRequests: 70, remainingPercentage: 30, overage: 0, overageAllowedWithExhaustedQuota: false }] });
    f.quotas.set("claude", { provider: "claude", updatedAt: null, snapshots: [], status: "unsupported" });
    f.quotas.set("opencode", { provider: "opencode", updatedAt: null, snapshots: [], status: "loading" });
    for (const transport of ["mcp", "cli"] as const) {
      const before = structuredClone(OPERATING_POLICY_PROVIDERS.map((provider) => ({ provider, telemetry: f.quotas.get(provider) ?? null })));
      assert.deepEqual((await endpoint.call(transport, "get_provider_quota")).providers, before);
      assert.deepEqual(OPERATING_POLICY_PROVIDERS.map((provider) => ({ provider, telemetry: f.quotas.get(provider) ?? null })), before);
      const stale = { provider: "codex", updatedAt: "2026-01-01T00:00:00.000Z", snapshots: [], status: "error" as const, rateLimits: [{ quotaKey: "primary", usedPercentage: 85, windowDurationMinutes: 300, resetDate: "2026-01-01T05:00:00.000Z" }] };
      f.quotas.set("codex", stale);
      const beforeStale = structuredClone(stale);
      assert.deepEqual((await endpoint.call(transport, "get_provider_quota", { provider: "codex" })).providers, [{ provider: "codex", telemetry: beforeStale }]);
      assert.deepEqual(f.quotas.get("codex"), beforeStale);
      assert.deepEqual((await endpoint.call(transport, "get_selection_policy")).policy, policy);
      f.quotas.delete("codex");
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "同一repositoryの別worktreeから両入口で配置設定を共有し、既存・未設定・新規候補・単発指定を区別してGitと設定を照会で変更しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/943" }
// fault = "worktreeごとに別設定になる、分類を固定する、未設定時にSessionFolderへfallbackする、照会でWorktree作成や単発指定保存を行う"
// observable = "両入口のstatus/path/missing/保存rule、再起動後の設定、実Git worktree一覧・statusと候補Directory不存在"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→実Storage Workerと一時Git repository・linked worktree"
// lifecycle = "permanent"
// distinction = "schemaやGit helper単体では同一repo認識と両入口永続設定の組合せを確認できない"
// @end-test-value
test("worktree rules resolve shared destinations and existing paths without Git mutations", async () => {
  const f = await fixture();
  try {
    const repo = join(f.directory, "repo"), linked = join(f.directory, "existing"), root = join(f.directory, "GitWorktree");
    await f.git(f.directory, "init", "-b", "main", repo);
    await f.git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
    await f.git(repo, "worktree", "add", "-b", "existing", linked);
    const parent = await f.endpoint("codex", repo), other = await f.endpoint("opencode", linked);
    const initial = await f.git(repo, "worktree", "list", "--porcelain", "-z");
    const missing = await parent.call("mcp", "resolve_worktree", { branch: "feat/issue-938" });
    assert.equal(missing.status, "unconfigured"); assert.equal(missing.destinationPath, null); assert.deepEqual(missing.missing, ["rootPath", "repositoryRule"]);
    const existing = await parent.call("cli", "resolve_worktree", { branch: "existing" });
    assert.equal(existing.status, "existing"); assert.equal(existing.source, "git"); assert.equal(existing.destinationPath, linked);
    await parent.call("cli", "set_worktree_root", { rootPath: root });
    assert.deepEqual((await other.call("mcp", "resolve_worktree", { branch: "feat/issue-938" })).missing, ["repositoryRule"]);
    await other.call("mcp", "set_worktree_repository", { rule });
    const saved = await parent.call("cli", "get_worktree_policy");
    assert.deepEqual(saved, await other.call("mcp", "get_worktree_policy"));
    const clone = join(f.directory, "clone");
    await f.git(f.directory, "clone", repo, clone);
    const unrelated = await parent.call("mcp", "get_worktree_policy", { workspacePath: clone });
    assert.equal(unrelated.rootPath, root); assert.equal(unrelated.rule, null);
    assert.notEqual(unrelated.repositoryId, saved.repositoryId);
    await parent.call("cli", "set_worktree_repository", { workspacePath: clone, rule: { ...rule, repositoryName: "Clone" } });
    assert.deepEqual(await parent.call("mcp", "get_worktree_policy"), saved);
    const expected = join(root, "Electron", "WithMate", "feat", "issue-938");
    for (const endpoint of [parent, other]) for (const transport of ["mcp", "cli"] as const) {
      const planned = await endpoint.call(transport, "resolve_worktree", { branch: "feat/issue-938" });
      assert.equal(planned.status, "planned"); assert.equal(planned.source, "policy"); assert.equal(planned.destinationPath, expected);
      const override = await endpoint.call(transport, "resolve_worktree", { branch: "feat/issue-938", destinationPath: join(f.directory, "one-off") });
      assert.equal(override.source, "override"); assert.equal(override.destinationPath, join(f.directory, "one-off"));
      const reused = await endpoint.call(transport, "resolve_worktree", { branch: "existing", destinationPath: join(f.directory, "one-off") });
      assert.equal(reused.status, "existing"); assert.equal(reused.destinationPath, linked);
      assert.deepEqual(await endpoint.call(transport, "get_worktree_policy"), saved);
    }
    await f.reopen();
    assert.deepEqual(await parent.call("mcp", "get_worktree_policy"), saved);
    for (const categoryPath of ["ChromeExtentions", ".net/MAUI", ""]) {
      const next = { ...rule, categoryPath, layout: "{repository}/branches/{branch}" };
      await parent.call("cli", "set_worktree_repository", { rule: next });
      const planned = await other.call("mcp", "resolve_worktree", { branch: "feat/test" });
      assert.equal(planned.destinationPath, join(root, categoryPath, "WithMate", "branches", "feat", "test"));
    }
    for (const body of [{ rootPath: "relative" }, { rootPath: "../escape" }]) assert.equal((await parent.call("mcp", "set_worktree_root", body)).ok, false);
    for (const patch of [{ categoryPath: "../escape" }, { layout: "../{repository}/{branch}" }, { repositoryName: "../repo" }, { layout: "{unknown}/{branch}" }]) {
      assert.equal((await parent.call("cli", "set_worktree_repository", { rule: { ...rule, ...patch } })).ok, false);
    }
    for (const branch of ["../escape", "@{-1}", "-branch"]) assert.equal((await other.call("mcp", "resolve_worktree", { branch })).ok, false);
    assert.equal(await f.git(repo, "worktree", "list", "--porcelain", "-z"), initial);
    assert.equal(await f.git(repo, "status", "--porcelain"), "");
    await assert.rejects(access(expected)); await assert.rejects(access(join(f.directory, "one-off")));
    await other.call("cli", "set_worktree_repository", { rule: null });
    assert.equal((await parent.call("mcp", "get_worktree_policy")).rule, null);
    await parent.call("mcp", "set_worktree_repository", { rule });
    await parent.call("cli", "set_worktree_root", { rootPath: null });
    const rootMissing = await other.call("mcp", "resolve_worktree", { branch: "feat/new" });
    assert.deepEqual(rootMissing.missing, ["rootPath"]);
    assert.deepEqual((await other.call("cli", "get_worktree_policy")).rule, rule);
    assert.equal((await parent.call("mcp", "get_worktree_policy", { workspacePath: f.directory })).ok, false);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "終了したTurnのMCP/CLIは端末共有方針を書き換えられない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "新規設定操作が既存のactive binding/Turn認可を迂回する"
// observable = "両入口のSESSION_BINDING_INVALID/effect noneと未変更の保存方針"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→runtime admission→Storage Worker"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("ended provider Turns cannot change shared operating configuration", async () => {
  const f = await fixture();
  try {
    const endpoint = await f.endpoint("claude");
    await endpoint.call("cli", "set_selection_policy", { policy });
    endpoint.end();
    for (const transport of ["cli", "mcp"] as const) {
      const rejected = await endpoint.call(transport, "set_selection_policy", { policy: null });
      assert.equal(rejected.code, "SESSION_BINDING_INVALID"); assert.equal(rejected.effect, "none");
      const root = await endpoint.call(transport, "set_worktree_root", { rootPath: f.directory });
      assert.equal(root.code, "SESSION_BINDING_INVALID"); assert.equal(root.effect, "none");
    }
    assert.deepEqual(await f.store.getSelectionPolicy(), policy);
    assert.equal((await f.store.getWorktreePolicy()).rootPath, null);
  } finally { await f.close(); }
});
