import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import {
  WITHMATE_MEMORY_FALLBACK_ADMISSION_ADAPTER_KIND,
  WITHMATE_MEMORY_FALLBACK_ADMISSION_CREDENTIAL_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-runtime-exchange.js";
import { publishRuntimeDiscoveryEntry } from "../../src/runtime-discovery/runtime-discovery-registry.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { CodexManagedMcpConfigService } from "../../src-electron/codex-managed-mcp-config.js";
import {
  GlossaryApplicationService,
  projectGlossaryCheckoutAuthority,
} from "../../src-electron/glossary-application-service.js";
import { GlossaryRuntimeService } from "../../src-electron/glossary-runtime-service.js";
import { createMemoryV6HttpServer } from "../../src-electron/memory-v6-http-server.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/provider-agent-runtime-turn-coordinator.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory-v6-http-server.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";
import { mergeDefinedProviderEnv } from "../../src-electron/provider-agent-runtime-binding.js";
import {
  resolveManagedMcpLauncherPaths,
  WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC,
  WITHMATE_MEMORY_MCP_LAUNCHER_SPEC,
} from "../../src-electron/managed-mcp-launcher.js";
import { resolveDevelopmentProviderBinaryPath } from "../../src-electron/provider-binary-paths.js";
import { getGlossaryAgentRuntimeOperations } from "../../src/glossary-operation-schema.js";
import { runWithMateMemoryCli } from "../withmate-memory.js";
import { buildWithMateMemoryCli } from "../build-withmate-memory-cli.js";
import { createWithMateGlossaryMcpServer } from "../withmate-glossary-mcp.js";
import { createWithMateMemoryMcpServer } from "../withmate-memory-mcp.js";
import {
  callWithMateMemoryRuntime,
  WithMateMemoryRuntimeExchangeError,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
} from "../withmate-memory-runtime-client.js";

const execFileAsync = promisify(execFile);
const moduleRequire = createRequire(import.meta.url);

const API_SECRET = "general-memory-api-secret";
const OPERATOR_SECRET = "general-memory-operator-secret";
const MCP_SECRET = "general-memory-mcp-secret";
const FALLBACK_ADMISSION_SECRET = "general-memory-fallback-admission-secret";
const APPLICATION_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_PATH = "C:/workspace/general-memory-project";
const PROJECT_ID = "project-general-memory";

type RuntimeFixture = {
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  runtimeConnectionEnv: NodeJS.ProcessEnv;
  bindingEnv: Record<string, string>;
  operatorEnv: NodeJS.ProcessEnv;
  registryRootDirectoryPath: string;
  workspacePath: string;
  client: Client;
  close(): Promise<void>;
};

async function createRuntimeFixture(options: {
  runtimeCall?: (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    requestOptions: { signal: AbortSignal; bindingReference?: string; turnCapability?: string },
  ) => Promise<WithMateMemoryRuntimeResponse>;
} = {}): Promise<RuntimeFixture> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-general-memory-mcp-"));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", tempDirectory], { windowsHide: true });
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character-a', 'Character A', ?, ?)")
    .run("2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  db.prepare(`
    INSERT INTO sessions_v6 (
      id, title, state, provider_id, catalog_revision, model_id, approval_mode,
      character_id, character_snapshot_json, created_at, updated_at, last_active_at
    ) VALUES ('session-a', 'Session A', 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-a', '{}', ?, ?, ?)
  `).run("2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  db.prepare(`
    INSERT INTO session_role_bindings_v6 (
      session_id, session_role, role_contract_revision, root_session_id,
      parent_session_id, delegation_depth
    ) VALUES ('session-a', 'standalone', 1, 'session-a', NULL, 0)
  `).run();
  db.close();
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6Service({
    storage,
    resolveProjectById: (id) => id === PROJECT_ID ? { id: PROJECT_ID, displayName: "General Memory" } : null,
    resolveProjectByPath: (projectPath) => projectPath === PROJECT_PATH
      ? { id: PROJECT_ID, displayName: "General Memory" }
      : null,
    resolveKnownProjectByPath: (projectPath) => projectPath === PROJECT_PATH
      ? { id: PROJECT_ID, displayName: "General Memory" }
      : null,
    resolveCharacterById: (id) => id === "character-a" ? { id, name: "Character A" } : null,
  });
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const glossaryApplicationService = new GlossaryApplicationService();
  const glossaryTarget = await glossaryApplicationService.resolvePrimaryCheckout(tempDirectory);
  const binding = bindings.issueOrReuse({
    actorSessionId: "session-a",
    providerId: "codex",
    authoritySnapshot: {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: [PROJECT_ID],
      glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(glossaryTarget),
    },
    operationGrants: [
      ...getMemoryV6AgentRuntimeOperations(),
      ...getGlossaryAgentRuntimeOperations(),
    ],
  });
  const turn = turns.begin({ actorSessionId: "session-a", providerId: "codex" });
  const glossaryRuntime = new GlossaryRuntimeService({
    applicationService: glossaryApplicationService,
    bindingRegistry: bindings,
    resolveActorSession: (sessionId) => sessionId === "session-a"
      ? {
        id: "session-a",
        providerId: "codex",
        characterId: "character-a",
        workspacePath: tempDirectory,
      }
      : null,
    getProactiveCreateLimit: () => null,
    providerAgentRuntimeTurns: turns,
  });
  const runtime = createMemoryV6HttpServer({
    service,
    apiSecret: API_SECRET,
    operatorApiSecret: OPERATOR_SECRET,
    mcpApiSecret: MCP_SECRET,
    fallbackAdmissionApiSecret: FALLBACK_ADMISSION_SECRET,
    applicationInstanceId: APPLICATION_INSTANCE_ID,
    runtimeInstanceId: RUNTIME_ID,
    agentRuntimeBindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
    resolveActorSession: (sessionId) => sessionId === "session-a"
      ? { id: "session-a", providerId: "codex", characterId: "character-a" }
      : null,
    resolveProjectById: (id) => id === PROJECT_ID ? { id: PROJECT_ID, displayName: "General Memory" } : null,
    resolveKnownProjectByPath: (projectPath) => projectPath === PROJECT_PATH
      ? { id: PROJECT_ID, displayName: "General Memory" }
      : null,
    routeAgentRuntimeExtension: (request) => glossaryRuntime.route(request),
  });
  await runtime.start();
  const address = runtime.address();
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const registryRootDirectoryPath = join(tempDirectory, "runtime-registry");
  const registryPublication = await publishRuntimeDiscoveryEntry({
    rootDirectoryPath: registryRootDirectoryPath,
    security: async () => undefined,
    identity: {
      applicationInstanceId: APPLICATION_INSTANCE_ID,
      runtimeKind: "memory",
      runtimeGenerationId: RUNTIME_ID,
    },
    buildChannel: "development",
    process: { pid: process.pid, startedAt: new Date().toISOString() },
    credentialDocuments: [{
      adapterKind: WITHMATE_MEMORY_FALLBACK_ADMISSION_ADAPTER_KIND,
      document: {
        schemaVersion: "withmate-runtime-credential-v1",
        applicationInstanceId: APPLICATION_INSTANCE_ID,
        runtimeKind: "memory",
        adapterKind: WITHMATE_MEMORY_FALLBACK_ADMISSION_ADAPTER_KIND,
        runtimeGenerationId: RUNTIME_ID,
        credential: {
          schemaVersion: WITHMATE_MEMORY_FALLBACK_ADMISSION_CREDENTIAL_SCHEMA_VERSION,
          admissionSecret: FALLBACK_ADMISSION_SECRET,
        },
      },
    }],
    challenge: async () => true,
  });
  const runtimeConnectionEnv = {
    WITHMATE_MEMORY_API_URL: baseUrl,
    WITHMATE_MEMORY_API_SECRET: API_SECRET,
    WITHMATE_MEMORY_OPERATOR_API_SECRET: OPERATOR_SECRET,
    WITHMATE_MEMORY_MCP_API_SECRET: MCP_SECRET,
  };
  const bindingEnv = {
    WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: APPLICATION_INSTANCE_ID,
    WITHMATE_MEMORY_RUNTIME_GENERATION_ID: RUNTIME_ID,
    WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
    WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
    WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability,
  };
  const env = { ...runtimeConnectionEnv, ...bindingEnv };
  const operatorEnv = {
    WITHMATE_MEMORY_API_URL: baseUrl,
    WITHMATE_MEMORY_API_SECRET: API_SECRET,
    WITHMATE_MEMORY_OPERATOR_API_SECRET: OPERATOR_SECRET,
    WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: RUNTIME_ID,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createWithMateMemoryMcpServer({
    env,
    runtimeCall: options.runtimeCall,
    registryRootDirectoryPath,
  });
  const client = new Client({ name: "general-memory-integration-test", version: "1.0.0" });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    baseUrl,
    env,
    runtimeConnectionEnv,
    bindingEnv,
    operatorEnv,
    registryRootDirectoryPath,
    workspacePath: tempDirectory,
    client,
    async close() {
      await client.close();
      await mcpServer.close();
      await runtime.stop();
      await registryPublication.unpublish();
      turns.end(turn);
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    },
  };
}

async function callCli(
  fixture: RuntimeFixture,
  command: string,
  body: unknown,
): Promise<{ exitCode: number; value: any }> {
  let output = "";
  const exitCode = await runWithMateMemoryCli([
    command,
    "--json",
    JSON.stringify(body),
    "--api-url",
    fixture.baseUrl,
  ], {
    env: fixture.operatorEnv,
    stdout: { write: (chunk) => { output += String(chunk); return true; } },
    stderr: { write: () => true },
  });
  return { exitCode, value: JSON.parse(output) };
}

async function callFallbackCli(
  fixture: RuntimeFixture,
  command: string,
  body: unknown,
): Promise<{ exitCode: number; value: any }> {
  let output = "";
  const exitCode = await runWithMateMemoryCli([
    command,
    "--fallback-from",
    "mcp",
    "--json",
    JSON.stringify(body),
  ], {
    env: fixture.env,
    stdout: { write: (chunk) => { output += String(chunk); return true; } },
    stderr: { write: () => true },
  });
  return { exitCode, value: JSON.parse(output) };
}

function operatorProjectTarget(ref: { type: "id"; id: string } | { type: "path"; path: string }) {
  return { owner: "project" as const, scope: "project" as const, project: ref };
}

function actorProjectTarget(ref: { type: "id"; id: string } | { type: "path"; path: string }) {
  return { kind: "project" as const, project: ref };
}

const CODEX_MCP_BINDING_ENV_VARS = [
  "WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE",
  "WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED",
  "WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY",
  "WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID",
  "WITHMATE_MEMORY_RUNTIME_GENERATION_ID",
];

type ManagedMcpName = "withmate-character-context" | "withmate-glossary";

async function resolveManagedMcpEnvVars(
  fixture: RuntimeFixture,
): Promise<Record<ManagedMcpName, string[]>> {
  const codexPath = resolveDevelopmentProviderBinaryPath(
    "codex",
    (specifier) => moduleRequire.resolve(specifier),
  );
  assert.ok(codexPath, "Installed Codex SDK must provide its matching native CLI.");

  const codexHome = join(fixture.workspacePath, "codex-home");
  await mkdir(codexHome);
  const configPath = join(codexHome, "config.toml");
  const userConfig = '[mcp_servers.unrelated]\ncommand = "unrelated-command"\nenabled = false\n';
  await writeFile(configPath, userConfig, "utf8");
  const cliEnv = mergeDefinedProviderEnv(process.env, { CODEX_HOME: codexHome });

  const installRoot = join(fixture.workspacePath, "packaged");
  const executablePath = join(installRoot, "WithMate.exe");
  const resourcesPath = join(installRoot, "resources");
  const launcherArtifacts = new Map([
    WITHMATE_MEMORY_MCP_LAUNCHER_SPEC,
    WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC,
  ].map((spec) => {
    const paths = resolveManagedMcpLauncherPaths({ spec, executablePath, resourcesPath });
    assert.ok(paths);
    return [paths.launcherPath, paths.packagedCliPath] as const;
  }));
  const service = new CodexManagedMcpConfigService({
    isPackagedApp: () => true,
    platform: "win32",
    executablePath,
    resourcesPath,
    processEnv: cliEnv,
    fileExists: (filePath) => launcherArtifacts.has(filePath)
      || [...launcherArtifacts.values()].includes(filePath),
    readTextFile: (filePath) => {
      const packagedCliPath = launcherArtifacts.get(filePath);
      assert.ok(packagedCliPath);
      return [
        "@echo off",
        "setlocal",
        "set ELECTRON_RUN_AS_NODE=1",
        `"${executablePath}" "${packagedCliPath}" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n");
    },
  });
  const overrides = await service.resolve({
    codexPath,
    workspacePath: fixture.workspacePath,
  });

  const readRecord = async (name: string) => {
    const { stdout } = await execFileAsync(codexPath, [
      "-C",
      fixture.workspacePath,
      ...overrides.flatMap((override) => ["-c", override]),
      "mcp",
      "get",
      name,
      "--json",
    ], {
      cwd: fixture.workspacePath,
      env: cliEnv,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(String(stdout));
  };
  const readEnvVars = async (name: ManagedMcpName): Promise<string[]> => {
    const record = await readRecord(name);
    assert.equal(record.enabled, true);
    assert.equal(record.transport?.command, join(installRoot,
      name === "withmate-character-context" ? "withmate-memory.cmd" : "withmate-glossary.cmd"));
    assert.deepEqual(record.transport?.args, ["mcp-server"]);
    const envVars: unknown = record.transport?.env_vars;
    assert.ok(Array.isArray(envVars) && envVars.every((value) => typeof value === "string"));
    return envVars;
  };

  const result = {
    "withmate-character-context": await readEnvVars("withmate-character-context"),
    "withmate-glossary": await readEnvVars("withmate-glossary"),
  };
  const unrelated = await readRecord("unrelated");
  assert.equal(unrelated.enabled, false);
  assert.equal(unrelated.transport.command, "unrelated-command");
  assert.equal(await readFile(configPath, "utf8"), userConfig);
  return result;
}

function forwardBindingEnv(
  bindingEnv: Record<string, string>,
  envVars: readonly string[],
): Record<string, string> {
  return Object.fromEntries(envVars.map((name) => [name, bindingEnv[name]]).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ));
}

describe("general Memory MCP runtime integration", () => {
  // @test-value v1
  // kind = "security"
  // claim = "Codex Session overrideのenv_varsから転送した同一binding authorityでMemoryとGlossaryのlist_targets operationが成功する"
  // oracle = { type = "issue", ref = "Issue #453 managed MCP operation reachability" }
  // failure_mode = "片方のMCPまたは必要なbinding変数がallowlistから欠落し、MCP initialize後のoperationがbinding requiredで失敗する"
  // scope = "codex-managed-mcp-binding-operation-integration"
  // lifecycle = "permanent"
  // distinction = "raw overrideの文字列一致ではなくCodex CLIのconfig解釈結果を実MCPと共有runtimeへ渡してoperation結果を観測する"
  // @end-test-value
  it("Codex env_varsを転送した両MCPから同じSessionのlist_targetsへ到達する", async () => {
    const fixture = await createRuntimeFixture();
    const memoryClient = new Client({ name: "codex-memory-binding-integration", version: "1.0.0" });
    const glossaryClient = new Client({ name: "codex-glossary-binding-integration", version: "1.0.0" });
    const [memoryClientTransport, memoryServerTransport] = InMemoryTransport.createLinkedPair();
    const [glossaryClientTransport, glossaryServerTransport] = InMemoryTransport.createLinkedPair();
    let memoryServer: ReturnType<typeof createWithMateMemoryMcpServer> | undefined;
    let glossaryServer: ReturnType<typeof createWithMateGlossaryMcpServer> | undefined;
    try {
      const envVars = await resolveManagedMcpEnvVars(fixture);
      assert.deepEqual(envVars["withmate-character-context"], CODEX_MCP_BINDING_ENV_VARS);
      assert.deepEqual(envVars["withmate-glossary"], CODEX_MCP_BINDING_ENV_VARS);

      memoryServer = createWithMateMemoryMcpServer({
        env: {
          ...fixture.runtimeConnectionEnv,
          ...forwardBindingEnv(fixture.bindingEnv, envVars["withmate-character-context"]),
        },
        registryRootDirectoryPath: fixture.registryRootDirectoryPath,
      });
      glossaryServer = createWithMateGlossaryMcpServer({
        env: {
          ...fixture.runtimeConnectionEnv,
          ...forwardBindingEnv(fixture.bindingEnv, envVars["withmate-glossary"]),
        },
        registryRootDirectoryPath: fixture.registryRootDirectoryPath,
      });
      await memoryServer.connect(memoryServerTransport);
      await glossaryServer.connect(glossaryServerTransport);
      await memoryClient.connect(memoryClientTransport);
      await glossaryClient.connect(glossaryClientTransport);

      const memoryTargets = await memoryClient.callTool({
        name: "memory.list_targets",
        arguments: { includeEmpty: true },
      });
      assert.equal(memoryTargets.isError, undefined, JSON.stringify(memoryTargets));
      assert.ok(Array.isArray((memoryTargets.structuredContent as any).items));

      const glossaryTargets = await glossaryClient.callTool({
        name: "glossary.list_targets",
        arguments: {},
      });
      assert.equal(glossaryTargets.isError, undefined, JSON.stringify(glossaryTargets));
      assert.equal((glossaryTargets.structuredContent as any).targets.length, 1);
      assert.equal((glossaryTargets.structuredContent as any).targets[0].isPrimary, true);
      assert.deepEqual((glossaryTargets.structuredContent as any).targets[0].selector, {
        kind: "checkout",
        checkoutId: (glossaryTargets.structuredContent as any).targets[0].checkoutId,
      });
    } finally {
      await memoryClient.close().catch(() => undefined);
      await glossaryClient.close().catch(() => undefined);
      await memoryServer?.close().catch(() => undefined);
      await glossaryServer?.close().catch(() => undefined);
      await fixture.close();
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "tools/list後のtransport failureはMCPへ渡した公開tool引数を変更しない同一binding・turnのCLI fallbackだけを許可する"
  // oracle = { type = "adr", ref = "ADR-024 operator CLI and agent-bound CLI fallback" }
  // failure_mode = "MCP内部fieldと公開CLI bodyの差で正当なfallbackを拒否する、またはadmissionを変更bodyへ横流ししてMemoryを更新する"
  // scope = "general-memory-mcp-cli-fallback-integration"
  // lifecycle = "permanent"
  // @end-test-value
  it("MCP transport failureのserver admissionで同一CLI fallbackだけを実行する", async () => {
    let failNextAppend = true;
    const fixture = await createRuntimeFixture({
      runtimeCall: async (connection, operation, requestOptions) => {
        if (operation.path === "/v1/append" && failNextAppend) {
          failNextAppend = false;
          throw new WithMateMemoryRuntimeExchangeError("simulated transport failure", false, {
            discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE",
          });
        }
        return callWithMateMemoryRuntime(connection, operation, requestOptions);
      },
    });
    const body = {
      target: { kind: "user-global" as const },
      kind: "decision",
      title: "Fallback admission",
      body: "Only the failed MCP operation may use CLI fallback.",
      preview: "Fallback admission is operation-bound.",
      tags: [],
      idempotencyKey: "fallback-admission-integration",
    };
    try {
      await fixture.client.listTools();
      const failed = await fixture.client.callTool({ name: "memory.append", arguments: body });
      assert.equal(failed.isError, true);
      assert.equal((failed.structuredContent as any).error.details.fallbackEligible, true);

      const fallback = await callFallbackCli(fixture, "append", body);
      assert.equal(fallback.exitCode, 0, JSON.stringify(fallback.value));
      assert.equal(fallback.value.created, true);

      const internalField = await callFallbackCli(fixture, "append", {
        ...body,
        schemaVersion: "attacker-controlled",
      });
      assert.notEqual(internalField.exitCode, 0);
      assert.equal(internalField.value.error.code, "WITHMATE_MEMORY_CLI_USAGE");

      const changed = await callFallbackCli(fixture, "append", {
        ...body,
        title: "Changed fallback",
      });
      assert.notEqual(changed.exitCode, 0);
      assert.equal(changed.value.error.code, "MEMORY_FORBIDDEN");
    } finally {
      await fixture.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "operator CLI explicit targetとbound MCP actor-relative targetは同じMemory application stateを相互参照する"
  // oracle = { type = "adr", ref = "ADR-024 operator and agent-facing target boundary" }
  // failure_mode = "CLI/MCPが別runtimeまたは別canonical targetへ分岐し、相互read-backできない"
  // scope = "general-memory-cli-mcp-parity"
  // lifecycle = "permanent"
  // @end-test-value
  it("CLI path appendをMCP ID readでき、MCP user-global appendをCLI readできる", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const cliAppend = await callCli(fixture, "append", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: operatorProjectTarget({ type: "path", path: PROJECT_PATH }),
        kind: "decision",
        title: "Runtime boundary",
        body: "CLI and MCP share one Memory V6 application service.",
        preview: "CLI and MCP share one service.",
        tags: [{ type: "topic", value: "runtime-boundary" }],
        idempotencyKey: "cli-to-mcp-1",
      });
      assert.equal(cliAppend.exitCode, 0);

      const mcpRead = await fixture.client.callTool({
        name: "memory.get_entry",
        arguments: {
          entryId: cliAppend.value.entry.id,
          target: actorProjectTarget({ type: "id", id: PROJECT_ID }),
        },
      });
      assert.equal(mcpRead.isError, undefined, JSON.stringify(mcpRead));
      assert.equal((mcpRead.structuredContent as any).entry.id, cliAppend.value.entry.id);
      assert.deepEqual((mcpRead.structuredContent as any).entry.target, actorProjectTarget({ type: "id", id: PROJECT_ID }));

      const mcpAppend = await fixture.client.callTool({
        name: "memory.append",
        arguments: {
          target: { kind: "user-global" },
          kind: "preference",
          title: "Compact output",
          body: "Prefer compact output across projects.",
          preview: "Prefer compact output.",
          tags: [{ type: "topic", value: "output-style" }],
          idempotencyKey: "mcp-to-cli-1",
        },
      });
      assert.equal(mcpAppend.isError, undefined);

      const cliRead = await callCli(fixture, "get-entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: (mcpAppend.structuredContent as any).entry.id,
        target: { owner: "user", scope: "global" },
      });
      assert.equal(cliRead.exitCode, 0);
      assert.equal(cliRead.value.entry.id, (mcpAppend.structuredContent as any).entry.id);
      assert.equal(cliRead.value.entry.owner.type, "user");

      const fileUsage = await fixture.client.callTool({ name: "memory.file_usage", arguments: {} });
      assert.equal(fileUsage.isError, undefined, JSON.stringify(fileUsage));
      assert.equal((fileUsage.structuredContent as any).objectCount, 0);
      const fileExport = await fixture.client.callTool({
        name: "memory.get_file",
        arguments: {
          target: actorProjectTarget({ type: "id", id: PROJECT_ID }),
          objectId: "a".repeat(32),
          outputPath: "C:/exports/general-memory.bin",
        },
      });
      assert.equal(fileExport.isError, true);
      assert.equal((fileExport.structuredContent as any).error.code, "MEMORY_FILE_EXPORT_UNIMPLEMENTED");
    } finally {
      await fixture.close();
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "bound MCP mutationはactor-relative authority、dry-run、move、idempotent replay、conflictを同一runtimeで区別する"
  // oracle = { type = "adr", ref = "ADR-024 authority, idempotency, and effect certainty" }
  // failure_mode = "未許可targetがdispatchされる、dry-runがwriteする、またはretryとchanged requestが同じeffectへ畳まれる"
  // scope = "general-memory-mcp-mutation-state"
  // lifecycle = "permanent"
  // @end-test-value
  it("target mismatch、unknown target、dry-run、move、replayとidempotency conflictを区別する", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const appendArguments = {
        target: actorProjectTarget({ type: "id" as const, id: PROJECT_ID }),
        kind: "constraint",
        title: "Explicit target",
        body: "General Memory operations require an explicit target.",
        preview: "General Memory requires explicit targets.",
        tags: [{ type: "topic", value: "target" }],
        idempotencyKey: "mcp-replay-1",
      };
      const first = await fixture.client.callTool({ name: "memory.append", arguments: appendArguments });
      const replay = await fixture.client.callTool({ name: "memory.append", arguments: appendArguments });
      assert.equal((first.structuredContent as any).created, true, JSON.stringify(first));
      assert.equal((first.structuredContent as any).replayed, undefined);
      assert.equal((replay.structuredContent as any).created, true);
      assert.equal((replay.structuredContent as any).replayed, true);
      assert.equal((replay.structuredContent as any).entry.id, (first.structuredContent as any).entry.id);

      const conflict = await fixture.client.callTool({
        name: "memory.append",
        arguments: { ...appendArguments, title: "Changed request" },
      });
      assert.equal(conflict.isError, true);
      assert.equal((conflict.structuredContent as any).error.code, "MEMORY_IDEMPOTENCY_CONFLICT");

      const wrongOwner = await fixture.client.callTool({
        name: "memory.get_entry",
        arguments: {
          entryId: (first.structuredContent as any).entry.id,
          target: { kind: "user-global" },
        },
      });
      assert.equal(wrongOwner.isError, true);
      assert.equal((wrongOwner.structuredContent as any).error.code, "MEMORY_ENTRY_NOT_FOUND");

      const unknownTarget = await fixture.client.callTool({
        name: "memory.list_entries",
        arguments: { target: actorProjectTarget({ type: "id", id: "missing-project" }) },
      });
      assert.equal(unknownTarget.isError, true);
      assert.equal((unknownTarget.structuredContent as any).error.code, "MEMORY_INVALID_FIELD");
      assert.equal((unknownTarget.structuredContent as any).error.field, "target");

      const dryRun = await fixture.client.callTool({
        name: "memory.forget",
        arguments: {
          target: actorProjectTarget({ type: "path", path: PROJECT_PATH }),
          entryIds: [(first.structuredContent as any).entry.id],
          reason: "user_request",
          idempotencyKey: "mcp-forget-preview-1",
          dryRun: true,
        },
      });
      assert.ok(dryRun.structuredContent, JSON.stringify(dryRun));
      assert.equal((dryRun.structuredContent as any).dryRun, true);
      assert.equal((dryRun.structuredContent as any).writeOccurred, false);

      const moved = await fixture.client.callTool({
        name: "memory.move_entry",
        arguments: {
          entryId: (first.structuredContent as any).entry.id,
          from: actorProjectTarget({ type: "path", path: PROJECT_PATH }),
          to: { kind: "user-global" },
          reason: "move to user scope",
          idempotencyKey: "mcp-move-1",
        },
      });
      assert.equal(moved.isError, undefined);
      assert.deepEqual((moved.structuredContent as any).entry.target, { kind: "user-global" });
      const moveReplay = await fixture.client.callTool({
        name: "memory.move_entry",
        arguments: {
          entryId: (first.structuredContent as any).entry.id,
          from: actorProjectTarget({ type: "path", path: PROJECT_PATH }),
          to: { kind: "user-global" },
          reason: "move to user scope",
          idempotencyKey: "mcp-move-1",
        },
      });
      assert.equal((moveReplay.structuredContent as any).replayed, true);

      const readAfterMove = await fixture.client.callTool({
        name: "memory.get_entry",
        arguments: {
          entryId: (first.structuredContent as any).entry.id,
          target: { kind: "user-global" },
        },
      });
      assert.equal(readAfterMove.isError, undefined);
      assert.equal((readAfterMove.structuredContent as any).entry.id, (first.structuredContent as any).entry.id);

      const forgetArguments = {
        target: { kind: "user-global" as const },
        entryIds: [(first.structuredContent as any).entry.id],
        reason: "user_request" as const,
        idempotencyKey: "mcp-forget-1",
      };
      const forgotten = await fixture.client.callTool({ name: "memory.forget", arguments: forgetArguments });
      const forgetReplay = await fixture.client.callTool({ name: "memory.forget", arguments: forgetArguments });
      assert.equal((forgotten.structuredContent as any).results[0].replayed, undefined);
      assert.equal((forgetReplay.structuredContent as any).results[0].replayed, true);
    } finally {
      await fixture.close();
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "分離配置した配布artifactもbindingとturn capabilityを伝搬し、actor-relative tools/list/read/writeを実行する"
  // oracle = { type = "adr", ref = "ADR-024 provider-common Memory MCP distribution boundary" }
  // failure_mode = "bundle後にschemaまたはprovider environment伝搬が欠落して実sourceと配布artifactの挙動が分裂する"
  // scope = "general-memory-distribution-artifact-smoke"
  // lifecycle = "permanent"
  // @end-test-value
  it("分離temp directoryの配布artifactからtools/listと代表read/writeを実行する", async () => {
    const fixture = await createRuntimeFixture();
    const artifactDirectory = await mkdtemp(join(tmpdir(), "withmate-general-memory-mcp-dist-"));
    const client = new Client({ name: "general-memory-distribution-smoke", version: "1.0.0" });
    try {
      const helperPath = await buildWithMateMemoryCli(artifactDirectory);
      const childEnv = mergeDefinedProviderEnv(
        process.env,
        Object.fromEntries(
          Object.entries(fixture.env)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [helperPath, "mcp-server"],
        cwd: artifactDirectory,
        env: childEnv,
        stderr: "pipe",
      });
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.some((tool) => tool.name === "memory.search"), true);
      assert.equal(tools.tools.some((tool) => tool.name === "memory.append"), true);
      assert.equal(tools.tools.some((tool) => tool.name === "character_context.get"), true);

      const append = await client.callTool({
        name: "memory.append",
        arguments: {
          target: { kind: "user-global" },
          kind: "context",
          title: "Distribution smoke",
          body: "The isolated distribution artifact reached the shared runtime.",
          preview: "Isolated artifact reached the runtime.",
          tags: [{ type: "topic", value: "distribution-smoke" }],
          idempotencyKey: "distribution-smoke-1",
        },
      });
      assert.equal(append.isError, undefined, JSON.stringify(append));

      const search = await client.callTool({
        name: "memory.search",
        arguments: {
          targets: [{ kind: "user-global" }],
          query: "distribution smoke",
        },
      });
      assert.equal(search.isError, undefined);
      assert.deepEqual(
        (search.structuredContent as any).items.map((item: { id: string }) => item.id),
        [(append.structuredContent as any).entry.id],
      );
    } finally {
      await client.close().catch(() => undefined);
      await fixture.close();
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });
});
