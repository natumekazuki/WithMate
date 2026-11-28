import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LocalPrAgentRuntimeDeps } from "../../src-electron/local-pr/local-pr-agent-runtime.js";
import { startAgentRuntimeApi } from "../../src-electron/platform/agent-runtime/runtime-api.js";
import { resolveAgentRuntimeApi } from "../../src-electron/platform/agent-runtime/runtime-client.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import type { RelatedSession } from "../../src-electron/session/session-relationship-resolver.js";
import { localPrAgentData, localPrAgentInput, type LocalPrData } from "../../src-shared/local-pr/local-pr-contract.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { fixtureSessionManagementScope } from "../main/fixtures/session-management-scope.js";

const bundledCli = fileURLToPath(new URL("../../resources/cli/withmate-session.mjs", import.meta.url));
const prId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const headCommit = "a".repeat(40), targetCommit = "b".repeat(40);

/** 実際の公開通信経路は、コメントの対象を維持し、Workspace と Turn を厳密に照合する認証や共通のマージ判定を迂回しない。 */
test("bundled Local PR CLI and managed HTTP MCP share the bound application and reject forged authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-pr-transport-"));
  const workspacePath = join(directory, "session-workspace");
  const registryDirectoryPath = join(directory, "runtime-registry");
  const actor = { kind: "auxiliary", sessionId: "aux", incarnationId: "aux-v1", mainSessionId: "main", mainIncarnationId: "main-v1" } as const;
  let saved: RelatedSession = { id: actor.sessionId, incarnationId: actor.incarnationId, kind: "auxiliary", mainSessionId: actor.mainSessionId,
    mainIncarnationId: actor.mainIncarnationId, rootSessionId: actor.mainSessionId, parentSessionId: null, createdBySessionId: null,
    sessionRole: "standalone", role: "auxiliary", title: "Review", description: "", runState: "running", provider: "codex", workspacePath };
  const executionOptions: SessionExecutionOptions = { model: "test", reasoningEffort: "", approvalMode: "never", codexSandboxMode: "read-only",
    codexReviewer: "user", codexSpeed: "standard", customAgentName: "" };
  const bindings = new AgentRuntimeBindingRegistry(), turns = new ProviderAgentRuntimeTurnCoordinator();
  const projection = bindings.issueOrReuse({ actorSessionId: actor.sessionId, providerId: "codex",
    authoritySnapshot: { sessionIdentity: actor, sessionWorkspacePath: workspacePath }, operationGrants: getSessionAgentRuntimeOperations() });
  const turn = turns.begin({ actorSessionId: actor.sessionId, providerId: "codex", executionOptions });
  const unused = async () => { throw new Error("Unexpected non-PR operation."); };
  const application = new SessionManagementApplication({ readSessionScope: fixtureSessionManagementScope(() => [saved]),
    operatingPolicy: unused, directories: unused, currentTurn: unused, crewFolder: unused, updateMetadata: unused,
    getInstructions: unused, setInstructions: unused,
    enqueue: unused, getReceipt: unused, cancelReceipt: unused, stopTurn: unused, steer: unused, createChild: unused, catalog: unused,
    coordinate: unused, readExecution: unused });
  const operations: string[] = [];
  const expectedRun = { id: runId, version: 1, headCommit, targetCommit, state: "running", startedAt: "t", finishedAt: null, exitCode: null, error: null };
  let beforeEffect: (() => Promise<void>) | undefined;
  const localPr: LocalPrAgentRuntimeDeps = {
    async execute(operation, input, context) {
      assert.deepEqual(context.actor, actor);
      assert.equal(context.workspacePath, workspacePath);
      assert.equal(context.providerId, "codex");
      assert.deepEqual(context.executionOptions, executionOptions);
      await beforeEffect?.();
      context.assertCurrent();
      operations.push(operation);
      // 承認と CI の効果は共通アプリケーションだけが担う。この fixture はその契約を再現し、シェルや Git は実行しない。
      if (operation === "pr_merge") return { ok: false, code: "LOCAL_PR_APPROVAL_REQUIRED", message: "GUI approval is required.", effect: "none" };
      if (operation === "pr_ci_start" || operation === "pr_ci_rerun") assert.equal((input as { prId: string }).prId, prId);
      let value: unknown = expectedRun;
      // アプリケーションと同様に送信されたアンカーを応答へ反映し、両クライアントが往復でアンカーを保持することを確認する。
      if (operation === "pr_comment") {
        const { anchor, version, body, replyTo } = localPrAgentInput.pr_comment.parse(input);
        value = { id: runId, version, anchor: anchor ?? null, body, replyTo: replyTo ?? null, author: actor, draft: false,
          createdAt: "t", updatedAt: "t" };
      } else if (operation === "pr_list") {
        value = { entries: [], hasMore: false };
      }
      return { ok: true, data: localPrAgentData[operation].parse(value) as LocalPrData<typeof operation> };
    },
  };
  const service = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: turns, localPr });
  const runtime = await startAgentRuntimeApi({ applicationInstanceId: "33333333-3333-4333-8333-333333333333", buildChannel: "development",
    registryDirectoryPath, runtimePathSecurity: async () => {}, agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    routeAgentRuntimeExtension: (request) => service.route(request) });
  const client = new Client({ name: "local-pr-integration", version: "1" });
  try {
    const runtimeOwner = { applicationInstanceId: runtime.applicationInstanceId, runtimeGenerationId: runtime.runtimeGenerationId };
    const injectedBinding = { ...projection, runtimeOwner, turnCapability: turn.capability };
    const mcp = runtime.managedMcp.issue(injectedBinding, turn);
    assert.ok(mcp.sessionUrl);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.sessionUrl), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: mcp.token } },
    }));
    const connection = await resolveAgentRuntimeApi({ adapter: "mcp", env: {}, registryRootDirectoryPath: registryDirectoryPath, ...runtimeOwner });
    assert.equal(connection.kind, "selected");
    if (connection.kind !== "selected") throw new Error("Fixture runtime discovery failed.");
    const env = { ...process.env, WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1", WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: projection.bindingReference,
      WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability, WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID: runtimeOwner.applicationInstanceId,
      WITHMATE_AGENT_RUNTIME_GENERATION_ID: runtimeOwner.runtimeGenerationId, WITHMATE_AGENT_RUNTIME_API_URL: connection.connection.api.baseUrl,
      WITHMATE_AGENT_RUNTIME_API_SECRET: connection.connection.api.apiSecret, WITHMATE_AGENT_RUNTIME_MCP_API_SECRET: connection.connection.credential.adapterSecret };
    /** テスト側の通信アダプターを介さず、実際に同梱されるエントリーを別の作業ディレクトリから実行する。 */
    const cli = async (command: string, body: Record<string, unknown>, override: NodeJS.ProcessEnv = {}) => {
      try {
        const result = await promisify(execFile)(process.execPath, [bundledCli, command, "--json", JSON.stringify(body)],
          { env: { ...env, ...override }, cwd: directory, windowsHide: true });
        return { exit: 0, value: JSON.parse(result.stdout) };
      } catch (error) {
        const failure = error as { code: number; stdout: string };
        return { exit: failure.code, value: JSON.parse(failure.stdout) };
      }
    };
    const tools = (await client.listTools()).tools;
    const cliSchema = (await cli("schema", {})).value.operations;
    assert.deepEqual(tools.filter(({ name }) => name.startsWith("session.pr_")).map(({ name }) => name.slice("session.".length)).sort(),
      Object.keys(cliSchema).filter((key) => key.startsWith("pr_")).sort());
    for (const internal of ["approve", "revoke", "save_draft", "discard_draft", "publish_drafts", "session_choices", "discuss"]) {
      assert.equal(internal in cliSchema, false);
      assert.equal(tools.some(({ name }) => name === `session.${internal}`), false);
    }
    for (const operation of ["pr_list", "pr_create", "pr_comment", "pr_merge", "pr_ci_rerun"]) {
      const tool = tools.find(({ name }) => name === `session.${operation}`)!;
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), Object.keys(cliSchema[operation].input.properties ?? {}).sort());
      assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), [...(cliSchema[operation].input.required ?? [])].sort());
    }
    for (const [operation, body, expected] of [
      ["pr_list", {}, { ok: true, data: { entries: [], hasMore: false } }],
      ["pr_merge", { prId, version: 1, headCommit, targetCommit }, { ok: false, code: "LOCAL_PR_APPROVAL_REQUIRED", message: "GUI approval is required.", effect: "none" }],
      ["pr_ci_start", { prId, version: 1 }, { ok: true, data: expectedRun }],
      ["pr_ci_rerun", { prId, version: 1, runId }, { ok: true, data: expectedRun }],
    ] as const) {
      const command = await cli(operation.replaceAll("_", "-"), body);
      const tool = await client.callTool({ name: `session.${operation}`, arguments: body });
      assert.deepEqual(command, { exit: expected.ok ? 0 : 1, value: expected });
      assert.deepEqual(tool.structuredContent, expected);
      assert.equal(tool.isError, expected.ok ? undefined : true);
    }

    const file = { mode: "full", path: "src/file.ts", side: "after" };
    const comment = { prId, version: 1, body: "Review comment" };
    for (const anchor of [undefined, { ...file, startLine: null, endLine: null }, { ...file, startLine: 2, endLine: 4 }]) {
      const arguments_ = { ...comment, ...(anchor ? { anchor } : {}) };
      const command = await cli("pr-comment", arguments_);
      const tool = await client.callTool({ name: "session.pr_comment", arguments: arguments_ });
      assert.equal(command.exit, 0);
      assert.deepEqual(command.value.data.anchor, anchor ?? null);
      assert.deepEqual(tool.structuredContent, command.value);
    }
    const invalidComment = { ...comment, anchor: { ...file, startLine: null, endLine: 2 } };
    const badComment = await cli("pr-comment", invalidComment);
    assert.equal(badComment.exit, 2);
    assert.equal(badComment.value.effect, "none");
    assert.deepEqual((await client.callTool({ name: "session.pr_comment", arguments: invalidComment })).structuredContent, badComment.value);

    const start = { prId, version: 1 };
    const override = { ...start, repoPath: directory, workspacePath: directory, actor };
    const invalid = await cli("pr-ci-start", override);
    const invalidTool = await client.callTool({ name: "session.pr_ci_start", arguments: override });
    assert.equal(invalid.exit, 2);
    assert.equal(invalid.value.code, "SESSION_INVALID_REQUEST");
    assert.equal(invalid.value.effect, "none");
    assert.equal(invalidTool.isError, true);
    assert.deepEqual(invalidTool.structuredContent, invalid.value);
    for (const token of [undefined, "forged"]) {
      const headers = token ? { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: token } : undefined;
      assert.equal((await fetch(mcp.sessionUrl, { method: "POST", headers })).status, 401);
    }
    assert.equal((await cli("pr-ci-start", start, { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "" })).value.code, "SESSION_BINDING_REQUIRED");
    assert.equal((await cli("pr-ci-start", start, { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "forged" })).value.code, "SESSION_BINDING_INVALID");
    assert.equal((await cli("pr-ci-start", start, { WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "forged" })).value.code, "SESSION_BINDING_INVALID");
    for (const changed of [{ workspacePath: directory }, { incarnationId: "aux-replaced" }, { mainIncarnationId: "main-replaced" }]) {
      const original = saved;
      saved = { ...original, ...changed };
      const command = await cli("pr-ci-start", start);
      const tool = await client.callTool({ name: "session.pr_ci_start", arguments: start });
      assert.equal(command.value.code, "SESSION_BINDING_INVALID");
      assert.equal(command.value.effect, "none");
      assert.deepEqual(tool.structuredContent, command.value);
      saved = original;
    }

    // 失効前に受け付けた呼び出しも、アプリケーションが効果を適用する境界では拒否する必要がある。
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    beforeEffect = () => { started.resolve(); return release.promise; };
    const pending = cli("pr-ci-start", start);
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error("CI never reached the effect boundary."); })]);
      turns.end(turn);
    } finally {
      release.resolve();
    }
    const inactive = await pending;
    assert.equal(inactive.value.code, "SESSION_BINDING_INVALID");
    assert.equal(inactive.value.effect, "none");
    assert.deepEqual(operations, ["pr_list", "pr_list", "pr_merge", "pr_merge", "pr_ci_start", "pr_ci_start", "pr_ci_rerun", "pr_ci_rerun",
      ...Array<string>(6).fill("pr_comment")]);
  } finally {
    await client.close();
    turns.end(turn);
    await runtime.stop();
    // このテストが作成した隔離ディレクトリだけを削除する。
    await rm(directory, { recursive: true, force: true });
  }
});
