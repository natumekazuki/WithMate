import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { createMemoryV6HttpServer } from "../../src-electron/memory-v6-http-server.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";
import { mergeDefinedProviderEnv } from "../../src-electron/provider-agent-runtime-binding.js";
import { runWithMateMemoryCli } from "../withmate-memory.js";
import { buildWithMateMemoryCli } from "../build-withmate-memory-cli.js";
import { createWithMateMemoryMcpServer } from "../withmate-memory-mcp.js";

const API_SECRET = "general-memory-api-secret";
const OPERATOR_SECRET = "general-memory-operator-secret";
const MCP_SECRET = "general-memory-mcp-secret";
const RUNTIME_ID = "general-memory-runtime";
const PROJECT_PATH = "C:/workspace/general-memory-project";
const PROJECT_ID = "project-general-memory";

type RuntimeFixture = {
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  client: Client;
  close(): Promise<void>;
};

async function createRuntimeFixture(): Promise<RuntimeFixture> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-general-memory-mcp-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
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
  const runtime = createMemoryV6HttpServer({
    service,
    apiSecret: API_SECRET,
    operatorApiSecret: OPERATOR_SECRET,
    mcpApiSecret: MCP_SECRET,
    runtimeInstanceId: RUNTIME_ID,
  });
  await runtime.start();
  const address = runtime.address();
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    WITHMATE_MEMORY_API_URL: baseUrl,
    WITHMATE_MEMORY_API_SECRET: API_SECRET,
    WITHMATE_MEMORY_OPERATOR_API_SECRET: OPERATOR_SECRET,
    WITHMATE_MEMORY_MCP_API_SECRET: MCP_SECRET,
    WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: RUNTIME_ID,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createWithMateMemoryMcpServer({ env });
  const client = new Client({ name: "general-memory-integration-test", version: "1.0.0" });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    baseUrl,
    env,
    client,
    async close() {
      await client.close();
      await mcpServer.close();
      await runtime.stop();
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
    env: fixture.env,
    stdout: { write: (chunk) => { output += String(chunk); return true; } },
    stderr: { write: () => true },
  });
  return { exitCode, value: JSON.parse(output) };
}

function projectTarget(ref: { type: "id"; id: string } | { type: "path"; path: string }) {
  return { owner: "project" as const, scope: "project" as const, project: ref };
}

describe("general Memory MCP runtime integration", () => {
  it("CLI path appendをMCP ID readでき、MCP user-global appendをCLI readできる", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const cliAppend = await callCli(fixture, "append", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: projectTarget({ type: "path", path: PROJECT_PATH }),
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
          target: projectTarget({ type: "id", id: PROJECT_ID }),
        },
      });
      assert.equal(mcpRead.isError, undefined);
      assert.equal((mcpRead.structuredContent as any).entry.id, cliAppend.value.entry.id);
      assert.equal((mcpRead.structuredContent as any).entry.owner.id, PROJECT_ID);

      const mcpAppend = await fixture.client.callTool({
        name: "memory.append",
        arguments: {
          target: { owner: "user", scope: "global" },
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
      assert.equal(fileUsage.isError, undefined);
      assert.equal((fileUsage.structuredContent as any).objectCount, 0);
      const fileExport = await fixture.client.callTool({
        name: "memory.get_file",
        arguments: {
          target: projectTarget({ type: "id", id: PROJECT_ID }),
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

  it("target mismatch、unknown target、dry-run、move、replayとidempotency conflictを区別する", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const appendArguments = {
        target: projectTarget({ type: "id" as const, id: PROJECT_ID }),
        kind: "constraint",
        title: "Explicit target",
        body: "General Memory operations require an explicit target.",
        preview: "General Memory requires explicit targets.",
        tags: [{ type: "topic", value: "target" }],
        idempotencyKey: "mcp-replay-1",
      };
      const first = await fixture.client.callTool({ name: "memory.append", arguments: appendArguments });
      const replay = await fixture.client.callTool({ name: "memory.append", arguments: appendArguments });
      assert.equal((first.structuredContent as any).created, true);
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
          target: { owner: "user", scope: "global" },
        },
      });
      assert.equal(wrongOwner.isError, true);
      assert.equal((wrongOwner.structuredContent as any).error.code, "MEMORY_ENTRY_NOT_FOUND");

      const unknownTarget = await fixture.client.callTool({
        name: "memory.list_entries",
        arguments: { target: projectTarget({ type: "id", id: "missing-project" }) },
      });
      assert.equal(unknownTarget.isError, true);
      assert.equal((unknownTarget.structuredContent as any).error.code, "MEMORY_TARGET_NOT_FOUND");

      const dryRun = await fixture.client.callTool({
        name: "memory.forget",
        arguments: {
          target: projectTarget({ type: "path", path: PROJECT_PATH }),
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
          from: projectTarget({ type: "path", path: PROJECT_PATH }),
          to: { owner: "user", scope: "global" },
          reason: "move to user scope",
          idempotencyKey: "mcp-move-1",
        },
      });
      assert.equal(moved.isError, undefined);
      assert.equal((moved.structuredContent as any).entry.owner.type, "user");
      const moveReplay = await fixture.client.callTool({
        name: "memory.move_entry",
        arguments: {
          entryId: (first.structuredContent as any).entry.id,
          from: projectTarget({ type: "path", path: PROJECT_PATH }),
          to: { owner: "user", scope: "global" },
          reason: "move to user scope",
          idempotencyKey: "mcp-move-1",
        },
      });
      assert.equal((moveReplay.structuredContent as any).replayed, true);

      const readAfterMove = await fixture.client.callTool({
        name: "memory.get_entry",
        arguments: {
          entryId: (first.structuredContent as any).entry.id,
          target: { owner: "user", scope: "global" },
        },
      });
      assert.equal(readAfterMove.isError, undefined);
      assert.equal((readAfterMove.structuredContent as any).entry.id, (first.structuredContent as any).entry.id);

      const forgetArguments = {
        target: { owner: "user" as const, scope: "global" as const },
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

  it("分離temp directoryの配布artifactからtools/listと代表read/writeを実行する", async () => {
    const fixture = await createRuntimeFixture();
    const artifactDirectory = await mkdtemp(join(tmpdir(), "withmate-general-memory-mcp-dist-"));
    const client = new Client({ name: "general-memory-distribution-smoke", version: "1.0.0" });
    try {
      const helperPath = await buildWithMateMemoryCli(artifactDirectory);
      const childEnv = mergeDefinedProviderEnv({ ...process.env, ...fixture.env }, {});
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
          target: { owner: "user", scope: "global" },
          kind: "context",
          title: "Distribution smoke",
          body: "The isolated distribution artifact reached the shared runtime.",
          preview: "Isolated artifact reached the runtime.",
          tags: [{ type: "topic", value: "distribution-smoke" }],
          idempotencyKey: "distribution-smoke-1",
        },
      });
      assert.equal(append.isError, undefined);

      const search = await client.callTool({
        name: "memory.search",
        arguments: {
          targets: [{ owner: "user", scope: "global" }],
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
