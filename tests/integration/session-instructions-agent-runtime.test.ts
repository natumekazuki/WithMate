import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAgentRuntimeApi, type AgentRuntimeApiHandle } from "../../src-electron/platform/agent-runtime/runtime-api.js";
import { resolveAgentRuntimeApi } from "../../src-electron/platform/agent-runtime/runtime-client.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { APP_DATABASE_V6_FILENAME } from "../../src-electron/storage/database-schema-v6.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";

const bundledCli = fileURLToPath(new URL("../../resources/cli/withmate-session.mjs", import.meta.url));

/** The distributed CLI and real managed HTTP MCP use the same worker-owned body and reject invalid, expired and cross-owner requests without modifying it. */
test("bundled CLI and managed HTTP MCP only read and replace their bound Session instructions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-instructions-transport-"));
  const registryDirectoryPath = join(directory, "runtime-registry");
  const bundle = createV6StorageWorkerBundle({ dbPath: join(directory, APP_DATABASE_V6_FILENAME), userDataPath: directory });
  let runningApi: AgentRuntimeApiHandle | undefined;
  t.after(async () => {
    await runningApi?.stop();
    await bundle.client.close();
    // Remove only the isolated fixture directory created above.
    await rm(directory, { recursive: true, force: true });
  });
  await bundle.initialize();
  const main = await bundle.stores.session.upsertSession(buildNewSession({
    id: "main", taskTitle: "Main", workspacePath: directory, workspaceLabel: "Workspace", branch: "",
    characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" },
    approvalMode: "on-request",
  }));
  const mainTarget = { kind: "main", sessionId: main.id, incarnationId: getSessionIncarnationId(main) } as const;
  const auxTarget = { kind: "auxiliary", sessionId: "aux", incarnationId: "2026-11-28T06:00:00.000Z", mainSessionId: main.id,
    mainIncarnationId: mainTarget.incarnationId } as const;
  await bundle.stores.auxiliary.upsertAuxiliarySession({
    ...main, id: auxTarget.sessionId, parentSessionId: main.id, title: "Auxiliary", runState: "idle",
    composerDraft: "", createdAt: auxTarget.incarnationId, displayAfterMessageIndex: null,
  });
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const instructions = bundle.stores.instructions;
  let beforeWrite: (() => Promise<void>) | undefined;
  let afterQueuedWrite: (() => void) | undefined;
  const unused = () => { throw new Error("Unexpected operation"); };
  const application = new SessionManagementApplication({
    readSessionScope: bundle.stores.session.readSessionManagementScope,
    operatingPolicy: unused, currentTurn: unused, crewFolder: unused, directories: unused, updateMetadata: unused,
    enqueue: unused, getReceipt: unused, cancelReceipt: unused, stopTurn: unused, steer: unused,
    readExecution: unused, coordinate: unused, createChild: unused, catalog: unused,
    getInstructions: async (target) => {
      const body = await instructions.get(target);
      assert.ok(body !== null);
      return body;
    },
    setInstructions: async (target, body) => {
      // Holding a write at its effect boundary lets the test revoke the original provider Turn.
      await beforeWrite?.();
      if (afterQueuedWrite) {
        // A fresh Worker cannot dispatch until the main thread processes its ready event.
        const delayed = createV6StorageWorkerBundle({ dbPath: join(directory, APP_DATABASE_V6_FILENAME), userDataPath: directory });
        try {
          const request = delayed.stores.instructions.set(target, body);
          afterQueuedWrite();
          const saved = await request;
          assert.ok(saved);
          return saved;
        } finally {
          await delayed.client.close();
        }
      }
      const saved = await instructions.set(target, body);
      assert.ok(saved);
      return saved;
    },
  });
  const service = new SessionManagementRuntimeService({ application, bindingRegistry: bindings, providerAgentRuntimeTurns: turns });
  const runtime = await startAgentRuntimeApi({ applicationInstanceId: "33333333-3333-4333-8333-333333333333", buildChannel: "development",
    registryDirectoryPath, runtimePathSecurity: async () => {}, agentRuntimeBindingRegistry: bindings, providerAgentRuntimeTurns: turns,
    routeAgentRuntimeExtension: (request) => service.route(request) });
  runningApi = runtime;
  const owner = { applicationInstanceId: runtime.applicationInstanceId, runtimeGenerationId: runtime.runtimeGenerationId };
  const connection = await resolveAgentRuntimeApi({ adapter: "mcp", env: {}, registryRootDirectoryPath: registryDirectoryPath, ...owner });
  assert.equal(connection.kind, "selected");
  if (connection.kind !== "selected") {
    // A discovery failure is a fixture error, not an authentication rejection under test.
    throw new Error("Fixture runtime discovery failed.");
  }

  /** Start a real binding and managed MCP credential for one saved actor and invoke the bundled CLI with the same authority. */
  const bind = async (target: SessionTarget) => {
    const binding = bindings.issueOrReuse({ actorSessionId: target.sessionId, providerId: "codex",
      authoritySnapshot: { sessionIdentity: target, sessionWorkspacePath: directory }, operationGrants: getSessionAgentRuntimeOperations() });
    const turn = turns.begin({ actorSessionId: target.sessionId, providerId: "codex" });
    const mcp = runtime.managedMcp.issue({ ...binding, runtimeOwner: owner, turnCapability: turn.capability }, turn);
    assert.ok(mcp.sessionUrl);
    const client = new Client({ name: "instructions-runtime", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.sessionUrl), {
      requestInit: { headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: mcp.token } },
    }));
    return { turn, client, sessionUrl: mcp.sessionUrl, cli: async (args: string[], override: NodeJS.ProcessEnv = {}) => {
      try {
        const result = await promisify(execFile)(process.execPath, [bundledCli, ...args], { cwd: directory, windowsHide: true, env: {
          ...process.env, WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1", WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
          WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability, WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID: owner.applicationInstanceId,
          WITHMATE_AGENT_RUNTIME_GENERATION_ID: owner.runtimeGenerationId, WITHMATE_AGENT_RUNTIME_API_URL: connection.connection.api.baseUrl,
          WITHMATE_AGENT_RUNTIME_API_SECRET: connection.connection.api.apiSecret, WITHMATE_AGENT_RUNTIME_MCP_API_SECRET: connection.connection.credential.adapterSecret,
          ...override,
        } });
        return { exit: 0, stdout: result.stdout };
      } catch (error) {
        // Nonzero CLI exits are part of the public error contract.
        const failure = error as { code: number; stdout: string };
        return { exit: failure.code, stdout: failure.stdout };
      }
    } };
  };
  const mainRuntime = await bind(mainTarget), auxRuntime = await bind(auxTarget);
  try {
    const help = await mainRuntime.cli(["help"]);
    assert.equal(help.exit, 0);
    assert.match(help.stdout, /get-instructions:.*No target is accepted/);
    assert.match(help.stdout, /set-instructions.*byteLength, not body/);
    const schema = JSON.parse((await mainRuntime.cli(["schema"])).stdout).operations;
    const tools = (await mainRuntime.client.listTools()).tools;
    // Verify the advertised schema as well as the runtime rejection of unexpected keys.
    for (const operation of ["get_instructions", "set_instructions"] as const) {
      const tool = tools.find(({ name }) => name === `session.${operation}`);
      assert.ok(tool);
      const fields = operation === "get_instructions" ? [] : ["body"];
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), fields);
      assert.deepEqual(tool.inputSchema, schema[operation].input);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.inputSchema.required ?? [], fields);
      assert.equal(tool.annotations?.readOnlyHint, operation === "get_instructions");
      assert.equal(tool.annotations?.destructiveHint, operation === "set_instructions");
    }
    const readArgs = ["get-instructions"];
    const mcpGet = { name: "session.get_instructions", arguments: {} };
    const cliRead = async (actor: typeof mainRuntime) => {
      const result = await actor.cli(readArgs);
      assert.equal(result.exit, 0, result.stdout);
      return JSON.parse(result.stdout);
    };
    const cliSet = (actor: typeof mainRuntime, input: Record<string, unknown>, override?: NodeJS.ProcessEnv) =>
      actor.cli(["set-instructions", "--json", JSON.stringify(input)], override);
    const initial = { ok: true, body: "" };
    assert.deepEqual(await cliRead(mainRuntime), initial);
    assert.deepEqual((await auxRuntime.client.callTool(mcpGet)).structuredContent, initial);
    const mainBody = " 椿😀\r\n " + "a".repeat(8181);
    const auxBody = "\n別の指示 🌸\n";
    const updateMain = await cliSet(mainRuntime, { body: mainBody });
    assert.equal(updateMain.exit, 0);
    assert.deepEqual(JSON.parse(updateMain.stdout), { ok: true, byteLength: 8192 });
    assert.deepEqual((await mainRuntime.client.callTool(mcpGet)).structuredContent, { ok: true, body: mainBody });
    assert.deepEqual(await cliRead(auxRuntime), initial);
    const mcpSet = { name: "session.set_instructions", arguments: { body: auxBody } };
    const updateAux = await auxRuntime.client.callTool(mcpSet);
    assert.deepEqual(updateAux.structuredContent, { ok: true, byteLength: 19 });
    assert.deepEqual(updateAux.content, [{ type: "text", text: JSON.stringify({ ok: true, byteLength: 19 }) }]);
    assert.deepEqual(await cliRead(auxRuntime), { ok: true, body: auxBody });
    const overflow = { body: mainBody + "x" };
    const rejectedCli = await cliSet(mainRuntime, overflow);
    const rejectedMcp = await mainRuntime.client.callTool({ name: "session.set_instructions", arguments: overflow });
    assert.equal(rejectedCli.exit, 2);
    assert.equal(rejectedMcp.isError, true);
    assert.deepEqual(rejectedMcp.structuredContent, {
      ok: false, code: "SESSION_INVALID_REQUEST", effect: "none", message: "Session instructions exceed the 8,192-byte limit.",
    });
    assert.deepEqual(JSON.parse(rejectedCli.stdout), rejectedMcp.structuredContent);

    // A target override fails identically in both adapters, for read and for write.
    for (const [name, args, input] of [
      ["get_instructions", readArgs, { target: mainTarget }],
      ["set_instructions", ["set-instructions"], { body: "forged", target: mainTarget }],
      ["set_instructions", ["set-instructions"], { body: 42 }],
    ] as const) {
      const cli = await auxRuntime.cli([...args, "--json", JSON.stringify(input)]);
      const tool = await auxRuntime.client.callTool({ name: `session.${name}`, arguments: input });
      assert.equal(cli.exit, 2, cli.stdout);
      assert.equal(tool.isError, true);
      assert.deepEqual(tool.structuredContent, JSON.parse(cli.stdout));
      assert.equal(tool.structuredContent?.code, "SESSION_INVALID_REQUEST");
      assert.equal(tool.structuredContent?.effect, "none");
    }
    const forged = await cliSet(auxRuntime, { body: "forged" }, { WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "forged" });
    assert.equal(JSON.parse(forged.stdout).code, "SESSION_BINDING_INVALID");
    const unbound = await auxRuntime.cli(readArgs, { WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "" });
    assert.equal(JSON.parse(unbound.stdout).code, "SESSION_BINDING_REQUIRED");
    const unauthorized = await fetch(auxRuntime.sessionUrl, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await cliRead(mainRuntime), { ok: true, body: mainBody });
    assert.deepEqual(await cliRead(auxRuntime), { ok: true, body: auxBody });
    assert.deepEqual((await auxRuntime.client.callTool({ ...mcpSet, arguments: { body: "" } })).structuredContent, { ok: true, byteLength: 0 });
    assert.deepEqual(await cliRead(auxRuntime), initial);

    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    beforeWrite = () => { started.resolve(); return release.promise; };
    const pending = cliSet(auxRuntime, { body: "must not be stored" });
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error("Replacement did not reach the effect boundary."); })]);
      turns.end(auxRuntime.turn);
    } finally {
      release.resolve();
    }
    const expired = JSON.parse((await pending).stdout);
    assert.equal(expired.code, "SESSION_BINDING_INVALID");
    assert.equal(expired.effect, "none");
    assert.equal(await instructions.get(auxTarget), "");

    // Revoking only the binding after queueing the command must also block the pending write.
    // Native completion can close the MCP connection without ending application-save admission.
    runtime.managedMcp.closeConnection(mainRuntime.turn);
    beforeWrite = undefined;
    afterQueuedWrite = () => bindings.revokeProviderExecution(mainTarget.sessionId, "codex");
    const bindingRevoked = await cliSet(mainRuntime, { body: "must not replace existing instructions" });
    assert.equal(bindingRevoked.exit, 1, bindingRevoked.stdout);
    assert.deepEqual(JSON.parse(bindingRevoked.stdout), {
      ok: false, code: "SESSION_BINDING_INVALID", effect: "none",
      message: "The captured binding or provider Turn ended before the operation was applied.",
    });
    assert.equal(turns.admit({ actorSessionId: mainTarget.sessionId, providerId: "codex", turnCapability: mainRuntime.turn.capability }).ok, true);
    assert.equal(await instructions.get(mainTarget), mainBody);
  } finally {
    await mainRuntime.client.close();
    await auxRuntime.client.close();
    turns.end(mainRuntime.turn);
    turns.end(auxRuntime.turn);
  }
});
