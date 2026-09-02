import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import { createMemoryErrorResponse } from "../../src/memory-v6/memory-response-contract.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../../src/memory-v6/memory-runtime-exchange.js";
import {
  DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  discoverWithMateMemoryApi,
  resolveRuntimeRequestTimeoutMs,
  runWithMateMemoryCli as runWithMateMemoryCliImpl,
  WITHMATE_MEMORY_CLI_EXIT_CODES,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryCliDeps,
} from "../withmate-memory.js";
import {
  resolveAgentRuntimeBindingReference,
  verifyRuntimeIdentity,
  WithMateMemoryRuntimeExchangeError,
  WITHMATE_MEMORY_API_SECRET_HEADER,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
} from "../withmate-memory-runtime-client.js";
import { publishRuntimeDiscoveryEntry } from "../../src/runtime-discovery/runtime-discovery-registry.js";

it("provider execution markerがある場合はbinding省略をlocal-userへdowngradeしない", () => {
  assert.throws(
    () => resolveAgentRuntimeBindingReference({ WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1" }),
    (error) => (
      typeof error === "object"
      && error !== null
      && "error" in error
      && (error as { error?: { message?: unknown } }).error?.message
        === "WithMate provider execution requires its runtime binding reference."
    ),
  );
  assert.equal(resolveAgentRuntimeBindingReference({}), undefined);
});

const TEST_API_SECRET = "test-api-secret";
const TEST_OPERATOR_SECRET = "test-operator-secret";
const TEST_RUNTIME_INSTANCE_ID = "test-runtime";
const TEST_RUNTIME_ENV = {
  WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
  WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
  WITHMATE_MEMORY_OPERATOR_API_SECRET: TEST_OPERATOR_SECRET,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: TEST_RUNTIME_INSTANCE_ID,
};

type LegacyCliTestDeps = WithMateMemoryCliDeps & { fetch?: typeof fetch };

function createLegacyRuntimeCall(fetchImpl: typeof fetch) {
  return async (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    options: { signal: AbortSignal },
  ): Promise<WithMateMemoryRuntimeResponse> => {
    try {
      if (!await verifyRuntimeIdentity(connection.api, fetchImpl, options.signal)) {
        throw new WithMateMemoryRuntimeExchangeError("Runtime identity mismatch.", false);
      }
    } catch (error) {
      if (error instanceof WithMateMemoryRuntimeExchangeError || (typeof error === "object" && error !== null && "error" in error)) {
        throw error;
      }
      throw new WithMateMemoryRuntimeExchangeError("Runtime identity check failed.", false, { cause: error });
    }
    const headers: Record<string, string> = {
      [WITHMATE_MEMORY_API_SECRET_HEADER]: connection.api.apiSecret,
    };
    if (operation.method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    if (operation.path.startsWith("/v1/character_")) {
      headers["x-withmate-memory-operator-api-secret"] = connection.credential.adapterSecret;
    }
    if (operation.fallbackFrom) {
      headers["x-withmate-fallback-from"] = operation.fallbackFrom;
    }
    let response: Response;
    try {
      response = await fetchImpl(`${connection.api.baseUrl}${operation.path}`, {
        method: operation.method,
        headers,
        body: operation.method === "POST" ? JSON.stringify(operation.body) : undefined,
        redirect: "error",
        signal: options.signal,
      });
    } catch (error) {
      throw new WithMateMemoryRuntimeExchangeError("Legacy test runtime request failed.", true, { cause: error });
    }
    const text = await response.text();
    if (!text.trim()) {
      return { ok: response.ok, status: response.status, value: {} };
    }
    try {
      return { ok: response.ok, status: response.status, value: JSON.parse(text) as unknown };
    } catch {
      throw createMemoryErrorResponse({
        code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
        message: "Memory API returned a non-JSON response.",
      });
    }
  };
}

async function runWithMateMemoryCli(args: readonly string[], deps: LegacyCliTestDeps = {}): Promise<number> {
  const { fetch: fetchImpl, ...runtimeDeps } = deps;
  return runWithMateMemoryCliImpl(args, {
    ...runtimeDeps,
    ...(fetchImpl ? { runtimeCall: createLegacyRuntimeCall(fetchImpl) } : {}),
  });
}

function createOutputCapture(): { stream: { write(chunk: string): boolean }; text(): string; lines(): string[]; json(): any } {
  let output = "";
  return {
    stream: {
      write(chunk: string): boolean {
        output += chunk;
        return true;
      },
    },
    text() {
      return output;
    },
    lines() {
      return output.trim().split(/\r?\n/).filter(Boolean);
    },
    json() {
      return JSON.parse(output.trim());
    },
  };
}

function createStatusChallengeResponse(url: string): Response {
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  return new Response(JSON.stringify({
    ok: true,
    runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
    challenge: {
      nonce,
      hmacSha256: createHmac("sha256", TEST_API_SECRET).update(nonce, "utf8").digest("base64url"),
    },
  }), { status: 200 });
}

function createStdin(value: string): NodeJS.ReadStream {
  return Object.assign(Readable.from([value]), { isTTY: false }) as NodeJS.ReadStream;
}

function isStatusChallengeRequest(url: string): boolean {
  const parsed = new URL(url);
  return parsed.pathname === "/v1/status" && parsed.searchParams.has("nonce");
}

function assertUsageError(error: unknown, messagePattern: RegExp): true {
  assert.equal(typeof error, "object");
  assert.equal((error as { error?: { code?: unknown } }).error?.code, "WITHMATE_MEMORY_CLI_USAGE");
  assert.match(String((error as { error?: { message?: unknown } }).error?.message), messagePattern);
  return true;
}

async function withHttpServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  runner: (baseUrl: string) => T | Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address() as AddressInfo;
    return await runner(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function listenServer(server: ReturnType<typeof createServer>, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("withmate-memory CLI", () => {
// @test-value v1
// kind = "security"
// claim = "agent CLI fallbackはMCP credentialとbound runtime identityを選び、bindingとturn capabilityを同じrequestへ伝搬する"
// oracle = { type = "adr", ref = "ADR-024 operator CLI and agent-bound CLI fallback" }
// failure_mode = "fallbackがoperator credentialへ昇格する、別runtimeを選ぶ、またはbinding/turnなしでmutationを送る"
// scope = "withmate-memory-agent-cli-fallback"
// lifecycle = "permanent"
// @end-test-value
it("agent CLI fallbackはMCP credentialとruntime bindingを使う", async () => {
  const stdout = createOutputCapture();
  const observed: Array<{ connection: WithMateMemoryRuntimeConnection; operation: WithMateMemoryRuntimeOperation; options: Record<string, unknown> }> = [];
  const body = {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    target: { kind: "project", project: { type: "id", id: "project-a" } },
    kind: "decision",
    title: "Fallback",
    body: "Fallback body",
    preview: "Fallback preview",
    tags: [],
    idempotencyKey: "fallback-append-a",
  };
  const exitCode = await runWithMateMemoryCliImpl([
    "append", "--fallback-from", "mcp", "--json", JSON.stringify(body),
  ], {
    env: {
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
      WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-a",
      WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "turn-a",
      WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
      WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "22222222-2222-4222-8222-222222222222",
      WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "22222222-2222-4222-8222-222222222222",
      WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
      WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
      WITHMATE_MEMORY_MCP_API_SECRET: "mcp-secret",
      WITHMATE_MEMORY_OPERATOR_API_SECRET: TEST_OPERATOR_SECRET,
    },
    stdout: stdout.stream,
    runtimeCall: async (connection, operation, options) => {
      observed.push({ connection, operation, options });
      return { ok: true, status: 200, value: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, created: true } };
    },
  });

  assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].connection.credential, { adapter: "mcp", adapterSecret: "mcp-secret" });
  assert.equal(observed[0].operation.fallbackFrom, "mcp");
  assert.deepEqual(observed[0].operation.body, body);
  assert.equal(observed[0].options.bindingReference, "binding-a");
  assert.equal(observed[0].options.turnCapability, "turn-a");
});

// @test-value v1
// kind = "security"
// claim = "agent CLI fallbackはoperator-only command、connection selector、binding policyまたはruntime ownerの欠落・不正をdispatch前に拒否する"
// oracle = { type = "adr", ref = "ADR-024 operator CLI and agent-bound CLI fallback" }
// failure_mode = "fallback markerによってoperator authority、caller選択runtime、またはbindingで選ばれていないunique runtimeへ到達する"
// scope = "withmate-memory-agent-cli-fallback"
// lifecycle = "permanent"
// @end-test-value
it("agent CLI fallbackはoperator-only入力とbound runtime情報の欠落・不正を拒否する", async () => {
  const boundEnv = {
    WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
    WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-a",
    WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
    WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "22222222-2222-4222-8222-222222222222",
  };
  for (const { args, env } of [
    { args: ["audit", "--fallback-from", "mcp", "--all-targets"], env: boundEnv },
    {
      args: ["search", "--fallback-from", "mcp", "--api-url", "http://127.0.0.1:7777", "--json", JSON.stringify({})],
      env: boundEnv,
    },
    { args: ["file-usage", "--fallback-from", "mcp", "--largest"], env: boundEnv },
    { args: ["search", "--fallback-from", "mcp", "--json", JSON.stringify({})], env: {} },
    {
      args: ["search", "--fallback-from", "mcp", "--json", JSON.stringify({})],
      env: {
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-a",
        WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
        WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "22222222-2222-4222-8222-222222222222",
      },
    },
    {
      args: ["search", "--fallback-from", "mcp", "--json", JSON.stringify({})],
      env: {
        WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-a",
      },
    },
    {
      args: ["search", "--fallback-from", "mcp", "--json", JSON.stringify({})],
      env: {
        ...boundEnv,
        WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "not-a-uuid",
      },
    },
  ]) {
    const stdout = createOutputCapture();
    let dispatched = false;
    const exitCode = await runWithMateMemoryCliImpl(args, {
      env,
      stdout: stdout.stream,
      runtimeCall: async () => {
        dispatched = true;
        return { ok: true, status: 200, value: {} };
      },
    });
    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
    assert.equal(dispatched, false);
  }
});

// @test-value v1
// kind = "contract"
// claim = "loopback環境変数からruntime接続情報を解決する"
// oracle = { type = "contract", ref = "memory runtime discovery" }
// failure_mode = "不正URLやgeneration情報を誤って受理する"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("loopbackの環境変数URLをdiscovery結果として使う", async () => {
    assert.deepEqual(
      await discoverWithMateMemoryApi({
        adapter: "cli",
        env: { ...TEST_RUNTIME_ENV, WITHMATE_MEMORY_API_URL: "http://127.0.0.1:3456/" },
        readFile: async () => {
          throw new Error("should not read discovery file");
        },
      }),
      {
        api: { baseUrl: "http://127.0.0.1:3456", apiSecret: TEST_API_SECRET, runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID, runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID },
        credential: { adapter: "cli", adapterSecret: TEST_OPERATOR_SECRET },
      },
    );
    assert.deepEqual(
      await discoverWithMateMemoryApi({
        adapter: "cli",
        env: { ...TEST_RUNTIME_ENV, WITHMATE_MEMORY_API_URL: "http://[::1]:3456/" },
      }),
      {
        api: { baseUrl: "http://[::1]:3456", apiSecret: TEST_API_SECRET, runtimeGenerationId: TEST_RUNTIME_INSTANCE_ID, runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID },
        credential: { adapter: "cli", adapterSecret: TEST_OPERATOR_SECRET },
      },
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({
        adapter: "cli",
        env: { WITHMATE_MEMORY_API_URL: "http://192.168.0.20:3456" },
        readFile: async () => {
          throw new Error("should not read discovery file");
        },
      }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({ adapter: "cli", env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1.evil.com:3456" } }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({ adapter: "cli", env: { WITHMATE_MEMORY_API_URL: "http://127.evil.com:3456" } }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
    await assert.rejects(
      () => discoverWithMateMemoryApi({ adapter: "cli", env: { WITHMATE_MEMORY_API_URL: "http://127.999.0.1:3456" } }),
      (error) => assertUsageError(error, /WITHMATE_MEMORY_API_URL/),
    );
  });

// @test-value v1
// kind = "contract"
// claim = "legacy discovery fileをcanonical generationへ変換する"
// oracle = { type = "contract", ref = "memory runtime discovery" }
// failure_mode = "旧形式のruntime identityを誤解釈する"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("discovery fileからloopback API URLを解決する", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-"));
    const discoveryFilePath = join(tempDirectory, "memory-v6-api.json");
    try {
      await writeFile(discoveryFilePath, JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        adapter: "cli",
        baseUrl: "http://localhost:4567",
        apiSecret: "discovery-secret",
        adapterSecret: "operator-secret",
        runtimeInstanceId: "runtime-from-discovery",
        publishedAt: "2026-08-10T00:00:00.000Z",
      }));

      assert.deepEqual(
        await discoverWithMateMemoryApi({ adapter: "cli", env: {}, discoveryFilePath }),
        {
          api: { baseUrl: "http://localhost:4567", apiSecret: "discovery-secret", runtimeGenerationId: "runtime-from-discovery", runtimeInstanceId: "runtime-from-discovery" },
          credential: { adapter: "cli", adapterSecret: "operator-secret" },
        },
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

// @test-value v1
// kind = "contract"
// claim = "runtime directoryのlegacy projectionを既定解決する"
// oracle = { type = "contract", ref = "memory runtime discovery" }
// failure_mode = "既定pathが別runtimeを参照する"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("runtime directoryのdiscovery fileを既定で読む", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-runtime-"));
    try {
      await writeFile(join(tempDirectory, "memory-v6.current.json"), JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        adapter: "cli",
        baseUrl: "http://127.0.0.1:4567",
        apiSecret: "api-secret",
        adapterSecret: "operator-secret",
        runtimeInstanceId: "runtime-a",
        publishedAt: "2026-08-10T00:00:00.000Z",
      }));

      assert.deepEqual(
        await discoverWithMateMemoryApi({
          adapter: "cli",
          env: {
            WITHMATE_MEMORY_RUNTIME_DIR: tempDirectory,
            WITHMATE_MEMORY_DISCOVERY_FILE: " ",
          },
        }),
        {
          api: { baseUrl: "http://127.0.0.1:4567", apiSecret: "api-secret", runtimeGenerationId: "runtime-a", runtimeInstanceId: "runtime-a" },
          credential: { adapter: "cli", adapterSecret: "operator-secret" },
        },
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("明示された--api-urlが不正な場合はdiscovery fileへfallbackしない", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-"));
    const discoveryFilePath = join(tempDirectory, "memory-v6-api.json");
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    try {
      await writeFile(discoveryFilePath, JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:4567",
      }));

      const exitCode = await runWithMateMemoryCli(["status", "--api-url", "http://example.com", "--discovery-file", discoveryFilePath], {
        env: {},
        stdout: stdout.stream,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
      assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
      assert.equal(stdout.json().error.effect, "none");
      assert.equal(fetchCalls, 0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

// @test-value v1
// kind = "regression"
// claim = "runtime unavailable時にDB直読みにfallbackしない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "停止runtimeへ接続できない"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("WithMate未起動時はDB直読みに逃げずWITHMATE_NOT_RUNNINGを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: {},
      stdout: stdout.stream,
      readFile: async () => {
        throw new Error("missing discovery file");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
  });

// @test-value v1
// kind = "regression"
// claim = "Character commandがruntime unavailableをstructured errorへ投影する"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "storage_unavailableの原因が識別不能になる"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("Character commandのruntime unavailableを共通error semanticsで返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli([
      "context-get",
      "--json",
      JSON.stringify({
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        sessionId: "session-a",
      }),
    ], {
      env: {},
      stdout: stdout.stream,
      readFile: async () => {
        throw new Error("missing discovery file");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.deepEqual(stdout.json(), {
      schemaVersion: "withmate-character-context-v1",
      error: {
        code: "storage_unavailable",
        message: "WithMate runtime discovery could not select a runtime.",
        retryable: true,
        conversationMayContinue: true,
        effect: "none",
        details: { discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE", candidates: [] },
      },
    });
  });

  it("Character writeのdispatch後timeoutはeffect unknownを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli([
      "character-memory-forget",
      "--json",
      JSON.stringify({
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        entryId: "entry-a",
        authority: { kind: "operator", reason: "Recovery test." },
        reason: "other",
        idempotencyKey: "forget-timeout-1",
      }),
    ], {
      env: {
        ...TEST_RUNTIME_ENV,
        WITHMATE_MEMORY_OPERATOR_API_SECRET: "operator-secret",
      },
      stdout: stdout.stream,
      requestTimeoutMs: 5,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "storage_unavailable");
    assert.equal(stdout.json().error.effect, "unknown");
    assert.equal(stdout.json().error.retryable, true);
  });

  it("Character readのdispatch後response lossはeffect noneを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli([
      "context-get",
      "--json",
      JSON.stringify({
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        sessionId: "session-a",
      }),
    ], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      requestTimeoutMs: 5,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "storage_unavailable");
    assert.equal(stdout.json().error.effect, "none");
    assert.equal(stdout.json().error.retryable, true);
  });

  it("一般Memoryのdispatch後response lossはreadをeffect none、writeをeffect unknownにする", async () => {
    const cases = [
      {
        command: "search",
        body: {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          targets: [{ owner: "user", scope: "global" }],
          query: "preference",
        },
        expectedEffect: "none",
      },
      {
        command: "append",
        body: {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          target: { owner: "user", scope: "global" },
          kind: "preference",
          title: "Compact output",
          body: "Prefer compact output.",
          preview: "Compact output.",
          tags: [],
          idempotencyKey: "cli-general-response-loss-1",
        },
        expectedEffect: "unknown",
      },
      {
        command: "forget",
        body: {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          target: { owner: "user", scope: "global" },
          entryIds: ["entry-a"],
          reason: "user_request",
          idempotencyKey: "cli-general-response-loss-dry-run-1",
          dryRun: true,
        },
        expectedEffect: "none",
      },
    ];
    for (const testCase of cases) {
      const stdout = createOutputCapture();
      const exitCode = await runWithMateMemoryCli([
        testCase.command,
        "--json",
        JSON.stringify(testCase.body),
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        runtimeCall: async () => {
          throw new WithMateMemoryRuntimeExchangeError("response lost", true);
        },
      });
      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
      assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_REQUEST_TIMEOUT");
      assert.equal(stdout.json().error.effect, testCase.expectedEffect);
      assert.equal(stdout.json().error.retryable, true);
    }
  });

  it("Character writeのpre-dispatch同期failureはeffect noneを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli([
      "character-memory-forget",
      "--json",
      JSON.stringify({
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        entryId: "entry-a",
        authority: { kind: "operator", reason: "Recovery test." },
        reason: "other",
        idempotencyKey: "forget-predispatch-1",
      }),
    ], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      runtimeCall: async () => {
        throw new TypeError("invalid request header");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "storage_unavailable");
    assert.equal(stdout.json().error.effect, "none");
  });

  it("Character commandのruntime HTTP errorを共通Character schemaへ変換する", async () => {
    for (const testCase of [
      { status: 401, expectedCode: "authority_denied" },
      { status: 413, expectedCode: "invalid_input" },
      { status: 500, expectedCode: "storage_unavailable" },
    ]) {
      const stdout = createOutputCapture();
      const exitCode = await runWithMateMemoryCli([
        "context-get",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
        }),
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        runtimeCall: async () => ({
          ok: false,
          status: testCase.status,
          value: createMemoryErrorResponse({ code: "MEMORY_UNAUTHORIZED", message: "rejected" }),
        }),
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
      assert.equal(stdout.json().schemaVersion, "withmate-character-context-v1");
      assert.equal(stdout.json().error.code, testCase.expectedCode);
      assert.equal(stdout.json().error.effect, "none");
      assert.equal(stdout.json().error.details.httpStatus, testCase.status);
    }
  });

// @test-value v1
// kind = "regression"
// claim = "stale endpoint接続失敗をruntime unavailableとして返す"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "終了済みruntimeへ接続を試みる"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("stale discovery endpointへ接続できない場合もWITHMATE_NOT_RUNNINGを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
  });

// @test-value v1
// kind = "regression"
// claim = "stale endpointの応答停止をtimeoutでboundedに処理する"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "応答しないruntimeがCLIを占有する"
// scope = "memory-cli-discovery"
// lifecycle = "permanent"
// @end-test-value
it("stale discovery endpointが応答しない場合はtimeoutしてWITHMATE_NOT_RUNNINGを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      requestTimeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
  });

  it("file operationは通常requestと別のtimeoutを使い、本体timeoutを明示する", async () => {
    assert.equal(resolveRuntimeRequestTimeoutMs("search"), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveRuntimeRequestTimeoutMs("get_file"), DEFAULT_FILE_OPERATION_REQUEST_TIMEOUT_MS);
    assert.equal(resolveRuntimeRequestTimeoutMs("export_files", { fileOperationRequestTimeoutMs: 20_000 }), 20_000);
    assert.equal(resolveRuntimeRequestTimeoutMs("append", { requestTimeoutMs: 5 }), 5);

    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      objectId: "a".repeat(32),
      outputPath: "C:/exports/file.bin",
    };

    const exitCode = await runWithMateMemoryCli(["get-file", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fileOperationRequestTimeoutMs: 5,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_REQUEST_TIMEOUT");
    assert.equal(stdout.json().error.field, "get_file");
  });

  it("statusはGETで/v1/statusへ送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined; headers: HeadersInit | undefined }> = [];
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json(), { ok: true });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:7777\/v1\/status\?nonce=/);
    assert.deepEqual({ method: requests[0].method, body: requests[0].body, headers: requests[0].headers }, {
      method: "GET",
      body: undefined,
      headers: undefined,
    });
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/status",
      method: "GET",
      body: undefined,
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("charactersはGETで/v1/charactersへ送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined; headers: HeadersInit | undefined }> = [];
    const responseBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      characters: [
        {
          id: "mika",
          name: "Mika",
          description: "Guitar",
        },
      ],
    };

    const exitCode = await runWithMateMemoryCli(["characters"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json(), responseBody);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/characters",
      method: "GET",
      body: undefined,
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("file-usageはGETで/v1/file_usageへ送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined; headers: HeadersInit | undefined }> = [];
    const responseBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      quotaBytes: 1073741824,
      usedBytes: 0,
      physicalBytes: 0,
      pendingDeleteBytes: 0,
      availableBytes: 1073741824,
      objectCount: 0,
      pendingDeleteCount: 0,
      quotaExceeded: false,
    };

    const exitCode = await runWithMateMemoryCli(["file-usage"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json(), responseBody);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/file_usage",
      method: "GET",
      body: undefined,
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("file-usage --largestはGET queryで候補数を指定する", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined; headers: HeadersInit | undefined }> = [];
    const responseBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      quotaBytes: 1073741824,
      usedBytes: 4096,
      physicalBytes: 4200,
      pendingDeleteBytes: 0,
      availableBytes: 1073737728,
      objectCount: 1,
      pendingDeleteCount: 0,
      quotaExceeded: false,
      largestEntries: [{
        entryId: "mem-large-files",
        title: "Large files",
        preview: "Large preview",
        totalFileBytes: 4096,
        fileCount: 1,
        updatedAt: "2026-07-04T00:00:00.000Z",
      }],
    };

    const exitCode = await runWithMateMemoryCli(["file-usage", "--largest", "--limit", "5"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify(responseBody), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json(), responseBody);
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/file_usage?largest=1&limit=5",
      method: "GET",
      body: undefined,
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("get-fileはJSON bodyをPOSTで送る", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      objectId: "a".repeat(32),
      outputPath: "C:/exports/file.bin",
    };
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["get-file", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        assert.equal(String(url), "http://127.0.0.1:7777/v1/get_file");
        assert.equal(init?.method, "POST");
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          objectId: requestBody.objectId,
          entryId: "mem-a",
          outputPath: requestBody.outputPath,
          bytesWritten: 12,
          contentType: "application/octet-stream",
          displayName: "file.bin",
        }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
    assert.equal(stdout.json().bytesWritten, 12);
  });

  it("export-filesはJSON bodyをPOSTで送る", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      entryId: "mem-a",
      outputDirectoryPath: "C:/exports",
    };
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["export-files", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        assert.equal(String(url), "http://127.0.0.1:7777/v1/export_files");
        assert.equal(init?.method, "POST");
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          entryId: requestBody.entryId,
          outputDirectoryPath: requestBody.outputDirectoryPath,
          exportedCount: 0,
          files: [],
        }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
    assert.equal(stdout.json().exportedCount, 0);
  });

  it("環境変数URLが不正な場合はdefault discovery fileへfallbackしない", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-runtime-"));
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    try {
      await writeFile(join(tempDirectory, "memory-v6-api.json"), JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:4567",
        apiSecret: TEST_API_SECRET,
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
      }));

      const exitCode = await runWithMateMemoryCli(["status"], {
        env: {
          WITHMATE_MEMORY_RUNTIME_DIR: tempDirectory,
          WITHMATE_MEMORY_API_URL: "http://example.com",
        },
        stdout: stdout.stream,
        fetch: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
      assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
      assert.equal(fetchCalls, 0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("discovery/envのapiSecretを内部API headerとして送る", async () => {
    const stdout = createOutputCapture();
    const requests: Array<{ url: string; method: string | undefined; headers: HeadersInit | undefined }> = [];
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: {
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777",
        WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
        WITHMATE_MEMORY_OPERATOR_API_SECRET: TEST_OPERATOR_SECRET,
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: TEST_RUNTIME_INSTANCE_ID,
      },
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, headers: init?.headers });
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      url: "http://127.0.0.1:7777/v1/status",
      method: "GET",
      headers: { "x-withmate-memory-api-secret": TEST_API_SECRET },
    });
  });

  it("searchはJSON bodyをPOSTで送る", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      query: "cli",
    };
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["search", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        assert.equal(String(url), "http://127.0.0.1:7777/v1/search");
        assert.equal(init?.method, "POST");
        assert.deepEqual(init?.headers, {
          "Content-Type": "application/json",
          "x-withmate-memory-api-secret": TEST_API_SECRET,
        });
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
    assert.deepEqual(stdout.json(), { schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] });
  });

  it("schemaはruntime接続なしでCLI capabilitiesを返す", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const exitCode = await runWithMateMemoryCli(["schema"], {
      env: {},
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(stdout.json().entryKinds, [
      "decision",
      "constraint",
      "convention",
      "context",
      "deferred",
      "preference",
      "relationship",
      "boundary",
      "note",
    ]);
    assert.deepEqual(stdout.json().forgetReasons, ["user_request", "incorrect", "outdated", "privacy", "other"]);
    assert.ok(stdout.json().commands.includes("characters"));
    assert.ok(stdout.json().commands.includes("file-usage"));
    assert.ok(stdout.json().commands.includes("get-file"));
    assert.ok(stdout.json().commands.includes("export-files"));
    assert.deepEqual(stdout.json().requestBodyInputs, ["--json", "--file", "@file", "--stdin"]);
    assert.deepEqual(stdout.json().targetSelectors.at(-1), {
      owner: "user",
      scope: "global",
      requiredFields: [],
    });
  });

  it("--helpはruntime接続なしでusage textを返す", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const exitCode = await runWithMateMemoryCli(["--help"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.match(stdout.text(), /Usage:\s+withmate-memory <command> \[options\]/);
    assert.doesNotMatch(stdout.text(), /--session-project/);
    assert.match(stdout.text(), /characters/);
    assert.match(stdout.text(), /file-usage/);
    assert.match(stdout.text(), /get-file/);
    assert.match(stdout.text(), /export-files/);
    assert.match(stdout.text(), /search --project/);
    assert.match(stdout.text(), /validate --command <list-targets\|list-entries\|audit\|search\|get-entry\|get-file\|export-files\|list-tags\|append\|forget\|move-entry>/);
  });

  it("command --helpもruntime接続なしでusage textを返す", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const exitCode = await runWithMateMemoryCli(["search", "--help"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.match(stdout.text(), /Commands:/);
    assert.match(stdout.text(), /--stdin/);
  });

  it("validateはrequest bodyをruntimeへ送らずに検証する", async () => {
    const stdout = createOutputCapture();
    let fetchCalls = 0;
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "decision",
      title: "Decision",
      body: "Body",
      preview: "Preview",
      tags: [{ type: "topic", value: "cli" }],
    };

    const exitCode = await runWithMateMemoryCli(["validate", "--command", "append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(fetchCalls, 0);
    assert.equal(stdout.json().valid, true);
    assert.equal(stdout.json().command, "append");
    assert.equal(stdout.json().value.tags[0].canonicalValue, "cli");
  });

  it("validateはuser-global targetを受け付ける", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "user", scope: "global" }],
      query: "global preference",
    };

    const exitCode = await runWithMateMemoryCli(["validate", "--command", "search", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        throw new Error("validate should not call runtime");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.equal(stdout.json().valid, true);
    assert.deepEqual(stdout.json().value.targets, [{ owner: "user", scope: "global" }]);
  });

  it("validateはinvalid requestをJSON errorで返す", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "investigation",
      title: "Decision",
      body: "Body",
      preview: "Preview",
      tags: [],
    };

    const exitCode = await runWithMateMemoryCli(["validate", "--command", "append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "MEMORY_INVALID_FIELD");
    assert.equal(stdout.json().error.field, "kind");
    assert.equal(stdout.json().error.effect, "none");
  });

  it("--stdinは明示的に標準入力からrequest bodyを読む", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      query: "cli",
    };
    let capturedBody: unknown = null;

    const exitCode = await runWithMateMemoryCli(["search", "--stdin"], {
      env: TEST_RUNTIME_ENV,
      stdin: createStdin(JSON.stringify(requestBody)),
      stdout: stdout.stream,
      fetch: async (url, init) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
    assert.deepEqual(capturedBody, requestBody);
  });

  it("@fileは--fileの短縮形としてrequest bodyを読む", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-at-file-"));
    const requestPath = join(tempDirectory, "search.json");
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      query: "cli",
    };
    let capturedBody: unknown = null;
    try {
      await writeFile(requestPath, JSON.stringify(requestBody), "utf8");

      const exitCode = await runWithMateMemoryCli(["search", `@${requestPath}`], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.deepEqual(capturedBody, requestBody);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("search shorthandはprojectとqueryからrequest bodyを作る", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-shorthand-"));
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli(["search", "--project", tempDirectory, "--query", "release workflow", "--limit", "3"], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(capturedBody.targets[0].project.path, tempDirectory.replace(/\\/g, "/"));
      assert.equal(capturedBody.query, "release workflow");
      assert.equal(capturedBody.limit, 3);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("search shorthandは--tag / --tagsからtagsを作り、query未指定時はtag値をqueryに使う", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-tags-"));
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli([
        "search",
        "--project",
        tempDirectory,
        "--tag",
        "delivery-cleanup",
        "--tags",
        "topic:relaygraph,source:docs",
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.query, "delivery-cleanup relaygraph docs");
      assert.deepEqual(capturedBody.tags, [
        { type: "topic", value: "delivery-cleanup" },
        { type: "topic", value: "relaygraph" },
        { type: "source", value: "docs" },
      ]);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("get-entry shorthandはprojectとentry idからrequest bodyを作る", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-get-entry-"));
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli([
        "get-entry",
        "--project",
        tempDirectory,
        "--entry-id",
        "mem-1",
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, entry: null }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(capturedBody.entryId, "mem-1");
      assert.equal(capturedBody.target.project.path, tempDirectory.replace(/\\/g, "/"));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("get-entry shorthandはtargetなしをusage errorにする", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["get-entry", "--entry-id", "mem-1"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        assert.fail("get-entry shorthand without target should not call runtime");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assertUsageError(stdout.json(), /get-entry shorthand requires --project/);
  });

  it("get-file shorthandはprojectとobject idとoutputからrequest bodyを作る", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-get-file-"));
    const outputPath = join(tempDirectory, "export.bin");
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli([
        "get-file",
        "--project",
        tempDirectory,
        "--object-id",
        "a".repeat(32),
        "--output",
        outputPath,
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({
            schemaVersion: MEMORY_V6_SCHEMA_VERSION,
            objectId: "a".repeat(32),
            entryId: "mem-a",
            outputPath,
            bytesWritten: 1,
            contentType: "",
            displayName: "",
          }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(capturedBody.objectId, "a".repeat(32));
      assert.equal(capturedBody.target.project.path, tempDirectory.replace(/\\/g, "/"));
      assert.equal(capturedBody.outputPath, outputPath);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("get-file shorthandはoutputなしをusage errorにする", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["get-file", "--project-id", "project-a", "--object-id", "a".repeat(32)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        assert.fail("get-file shorthand without output should not call runtime");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assertUsageError(stdout.json(), /get-file shorthand requires --output/);
  });

  it("export-files shorthandはprojectとentry idとoutput dirからrequest bodyを作る", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-export-files-"));
    const outputDirectoryPath = join(tempDirectory, "exports");
    let capturedBody: any = null;
    try {
      const exitCode = await runWithMateMemoryCli([
        "export-files",
        "--project",
        tempDirectory,
        "--entry-id",
        "mem-a",
        "--output-dir",
        outputDirectoryPath,
      ], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({
            schemaVersion: MEMORY_V6_SCHEMA_VERSION,
            entryId: "mem-a",
            outputDirectoryPath,
            exportedCount: 0,
            files: [],
          }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal(capturedBody.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal(capturedBody.entryId, "mem-a");
      assert.equal(capturedBody.target.project.path, tempDirectory.replace(/\\/g, "/"));
      assert.equal(capturedBody.outputDirectoryPath, outputDirectoryPath);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("export-files shorthandはoutput dirなしをusage errorにする", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["export-files", "--project-id", "project-a", "--entry-id", "mem-a"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async () => {
        assert.fail("export-files shorthand without output dir should not call runtime");
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assertUsageError(stdout.json(), /export-files shorthand requires --output-dir/);
  });

  it("project.pathの相対pathはCLIで拒否する", async () => {
    const stdout = createOutputCapture();
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-cli-cwd-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(tempDirectory);
      const exitCode = await runWithMateMemoryCli(["search", "--json", JSON.stringify({
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: "." } }],
        query: "cli",
      })], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          assert.fail(`relative project path should be rejected before runtime request: ${String(init?.body)}`);
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });

      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
      assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
      assert.match(stdout.json().error.message, /absolute path/);
    } finally {
      process.chdir(previousCwd);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("--session-projectは非対応optionとしてusage errorを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["search", "--session-project", "--query", "missing"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
    assert.match(stdout.json().error.message, /Unknown option: --session-project/);
  });

// @test-value v1
// kind = "security"
// claim = "redirect先へsecretとrequest bodyを転送しない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "redirect経由でcredentialが漏洩する"
// scope = "memory-cli-transport"
// lifecycle = "permanent"
// @end-test-value
it("POST redirectは追従せずrequest bodyを転送しない", async () => {
    let destinationRequests = 0;

    await withHttpServer((request, response) => {
      destinationRequests += 1;
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }, async (destinationUrl) => {
      await withHttpServer((request, response) => {
        request.resume();
        response.writeHead(307, { Location: `${destinationUrl}/leaked` });
        response.end();
      }, async (redirectUrl) => {
        const stdout = createOutputCapture();
        const exitCode = await runWithMateMemoryCli(["append", "--json", JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: "redirect",
          body: "redirect body",
          preview: "redirect",
          tags: [],
        })], {
          env: {
            WITHMATE_MEMORY_API_URL: redirectUrl,
            WITHMATE_MEMORY_API_SECRET: TEST_API_SECRET,
            WITHMATE_MEMORY_OPERATOR_API_SECRET: TEST_OPERATOR_SECRET,
            WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: TEST_RUNTIME_INSTANCE_ID,
          },
          stdout: stdout.stream,
        });

        assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
        assert.equal(stdout.json().error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
      });
    });

    assert.equal(destinationRequests, 0);
  });

// @test-value v1
// kind = "security"
// claim = "identity challenge失敗時にmutation bodyとsecretを送信しない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "port再利用先へ誤接続する"
// scope = "memory-cli-transport"
// lifecycle = "permanent"
// @end-test-value
it("runtime identityを検証できないport再利用先へmutation bodyやsecretを送らない", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "decision",
      title: "stale",
      body: "must not leak",
      preview: "stale",
      tags: [],
    };
    const requests: Array<{ url: string; method: string | undefined; headers: HeadersInit | undefined; body: BodyInit | null | undefined }> = [];

    const exitCode = await runWithMateMemoryCli(["append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
        return new Response(JSON.stringify({
          ok: true,
          runtimeInstanceId: "other-runtime",
          challenge: {
            nonce: new URL(String(url)).searchParams.get("nonce"),
            hmacSha256: "not-the-expected-challenge",
          },
        }), { status: 200 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.notRunning);
    assert.equal(stdout.json().error.code, "WITHMATE_RUNTIME_UNAVAILABLE");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:7777\/v1\/status\?nonce=/);
    assert.deepEqual({
      method: requests[0].method,
      headers: requests[0].headers,
      body: requests[0].body,
    }, {
      method: "GET",
      headers: undefined,
      body: undefined,
    });
  });

// @test-value v1
// kind = "security"
// claim = "challenge後のpeer差替えでdispatchを再実行しない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "偽peerへcredentialを再送する"
// scope = "memory-cli-transport"
// lifecycle = "permanent"
// @end-test-value
it("challenge後に同じportのpeerが差し替わってもcredentialとmutationを再送せず偽成功を拒否する", async () => {
    const firstObservedHeaders: Array<Record<string, string | string[] | undefined>> = [];
    let replacementRequests = 0;
    let replacementServer: ReturnType<typeof createServer> | null = null;
    let replacementListening: Promise<void> | null = null;
    const firstServer = createServer((request, response) => {
      firstObservedHeaders.push(request.headers);
      const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
      response.writeEarlyHints({
        link: "</v1/exchange>; rel=preconnect",
        [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: TEST_RUNTIME_INSTANCE_ID,
        [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
          TEST_API_SECRET,
          TEST_RUNTIME_INSTANCE_ID,
          typeof nonce === "string" ? nonce : "",
        ),
      }, () => {
        request.socket.destroy();
        firstServer.close(() => {
          replacementServer = createServer((_replacementRequest, replacementResponse) => {
            replacementRequests += 1;
            replacementResponse.writeHead(200, { "Content-Type": "application/json" });
            replacementResponse.end(JSON.stringify({ ok: true, forged: true }));
          });
          replacementListening = listenServer(replacementServer, port).then(() => undefined);
        });
      });
    });
    const port = await listenServer(firstServer);
    const stdout = createOutputCapture();
    try {
      const exitCode = await runWithMateMemoryCli([
        "character-memory-forget",
        "--json",
        JSON.stringify({
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          entryId: "entry-a",
          reason: "user_request",
          idempotencyKey: "swap-cli-1",
        }),
      ], {
        env: {
          ...TEST_RUNTIME_ENV,
          WITHMATE_MEMORY_API_URL: `http://127.0.0.1:${port}`,
        },
        stdout: stdout.stream,
      });
      if (replacementListening) {
        await replacementListening;
      }
      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
      assert.equal(stdout.json().error.code, "storage_unavailable");
      assert.equal(stdout.json().error.effect, "none");
      assert.equal(replacementRequests, 0);
      assert.equal(firstObservedHeaders.length, 1);
      assert.equal(firstObservedHeaders[0]["x-withmate-memory-api-secret"], undefined);
      assert.equal(firstObservedHeaders[0]["x-withmate-memory-operator-api-secret"], undefined);
      assert.equal(firstObservedHeaders[0]["content-length"], undefined);
    } finally {
      await closeServer(firstServer);
      if (replacementListening) {
        await replacementListening.catch(() => undefined);
      }
      if (replacementServer) {
        await closeServer(replacementServer);
      }
    }
  });

  it("API errorはレスポンスJSONをそのまま出し、apiErrorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["search", "--project-id", "project-a", "--query", "memory"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          error: { code: "MEMORY_FORBIDDEN", message: "forbidden" },
        }), { status: 403 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "MEMORY_FORBIDDEN");
  });

  it("appendはimporter由来API errorをそのまま出し、apiErrorで終了する", async () => {
    const stdout = createOutputCapture();
    const requestBody = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "decision",
      title: "file append",
      body: "file append body",
      preview: "file append",
      tags: [],
      files: [{
        path: "C:/trace/missing.png",
        summary: "Missing screenshot.",
      }],
    };

    const exitCode = await runWithMateMemoryCli(["append", "--json", JSON.stringify(requestBody)], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      fetch: async (url) => {
        if (isStatusChallengeRequest(String(url))) {
          return createStatusChallengeResponse(String(url));
        }
        return new Response(JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          error: {
            code: "MEMORY_INVALID_FIELD",
            message: "Memory protected object input file is not readable.",
            field: "files[0].path",
          },
        }), { status: 422 });
      },
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.apiError);
    assert.equal(stdout.json().error.code, "MEMORY_INVALID_FIELD");
    assert.equal(stdout.json().error.field, "files[0].path");
  });

  it("APIが非JSONを返した場合もstdoutにはJSON errorだけを出す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["status"], {
      env: TEST_RUNTIME_ENV,
      stdout: stdout.stream,
      stderr: createOutputCapture().stream,
      fetch: async () => new Response("<html>not memory api</html>", { status: 200 }),
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.transportError);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_TRANSPORT_ERROR");
  });

  it("maintenance shorthandはlist-targets、list-entries、tag countsをruntimeへ送る", async () => {
    const cases = [
      {
        args: ["list-targets", "--owner", "project", "--include-empty", "--limit", "100"],
        path: "/v1/list_targets",
        expected: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, owner: "project", includeEmpty: true, limit: 100 },
      },
      {
        args: ["list-entries", "--project-id", "project-a", "--limit", "100"],
        path: "/v1/list_entries",
        expected: {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          limit: 100,
        },
      },
      {
        args: ["list-entries", "--owner", "user", "--scope", "global", "--limit", "100"],
        path: "/v1/list_entries",
        expected: {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          target: { owner: "user", scope: "global" },
          limit: 100,
        },
      },
      {
        args: ["list-tags", "--project-id", "project-a", "--with-counts", "--sample-limit", "2"],
        path: "/v1/list_tags",
        expected: {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
          withCounts: true,
          sampleLimit: 2,
        },
      },
    ];
    for (const testCase of cases) {
      const stdout = createOutputCapture();
      let capturedBody: unknown;
      const exitCode = await runWithMateMemoryCli(testCase.args, {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url, init) => {
          if (isStatusChallengeRequest(String(url))) {
            return createStatusChallengeResponse(String(url));
          }
          assert.equal(String(url), `http://127.0.0.1:7777${testCase.path}`);
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, items: [] }), { status: 200 });
        },
      });
      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.deepEqual(capturedBody, testCase.expected);
    }
  });

  it("forget --file --dry-runはrequestへpreview flagを加え、move-entryは専用routeへ送る", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-maintenance-cli-"));
    try {
      const forgetPath = join(tempDirectory, "forget.json");
      const movePath = join(tempDirectory, "move.json");
      const target = { owner: "project", scope: "project", project: { type: "id", id: "project-a" } };
      await writeFile(forgetPath, JSON.stringify({
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target,
        entryIds: ["mem-a"],
      }), "utf8");
      await writeFile(movePath, JSON.stringify({
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-a",
        from: target,
        to: { owner: "user", scope: "global" },
        reason: "move to user scope",
        idempotencyKey: "move-a",
      }), "utf8");
      for (const [args, path, expectedDryRun] of [
        [["forget", "--file", forgetPath, "--dry-run"], "/v1/forget", true],
        [["move-entry", "--file", movePath], "/v1/move_entry", undefined],
      ] as const) {
        const stdout = createOutputCapture();
        let capturedBody: any;
        const exitCode = await runWithMateMemoryCli(args, {
          env: TEST_RUNTIME_ENV,
          stdout: stdout.stream,
          fetch: async (url, init) => {
            if (isStatusChallengeRequest(String(url))) {
              return createStatusChallengeResponse(String(url));
            }
            assert.equal(String(url), `http://127.0.0.1:7777${path}`);
            capturedBody = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION, results: [] }), { status: 200 });
          },
        });
        assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
        assert.equal(capturedBody.dryRun, expectedDryRun);
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("audit markdown/jsonlはbodyを要求せずmaintenance projectionを整形する", async () => {
    const response = {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      generatedAt: "2026-08-09T00:00:00.000Z",
      staleBefore: "2026-05-11T00:00:00.000Z",
      targets: [{
        target: {
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          owner: "project",
          scope: "project",
          project: { id: "project-a", displayName: "Project A" },
          entryCount: 1,
          tagCount: 1,
          lastUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
        countsByKind: { context: 1 },
        topTags: [{ type: "topic", value: "memory", entryCount: 1, latestUpdatedAt: "2026-01-01T00:00:00.000Z" }],
        staleOrProgressCandidates: [{ id: "mem-a", title: "PR opened", preview: "pending", updatedAt: "2026-01-01T00:00:00.000Z", reasons: ["progress_like_metadata"] }],
        wrongScopeCandidates: [],
        duplicateTitleCandidates: [{
          normalizedTitle: "pr opened",
          entries: [
            { id: "mem-a", title: "PR opened", preview: "pending", updatedAt: "2026-01-01T00:00:00.000Z", reasons: ["duplicate_normalized_title"] },
            { id: "mem-b", title: "PR_opened", preview: "pending", updatedAt: "2026-01-01T00:00:00.000Z", reasons: ["duplicate_normalized_title"] },
          ],
        }],
        documentationCandidates: [],
        suspiciousTagCandidates: [],
      }],
      nextCursor: "next-page",
    };
    for (const format of ["markdown", "jsonl"] as const) {
      const stdout = createOutputCapture();
      const exitCode = await runWithMateMemoryCli(["audit", "--all-targets", "--format", format], {
        env: TEST_RUNTIME_ENV,
        stdout: stdout.stream,
        fetch: async (url) => isStatusChallengeRequest(String(url))
          ? createStatusChallengeResponse(String(url))
          : new Response(JSON.stringify(response), { status: 200 }),
      });
      assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      if (format === "markdown") {
        assert.match(stdout.text(), /# WithMate Memory audit/);
        assert.match(stdout.text(), /Project A/);
        assert.match(stdout.text(), /context: 1/);
        assert.match(stdout.text(), /topic:memory — 1/);
        assert.match(stdout.text(), /pr opened — mem-a, mem-b/);
        assert.match(stdout.text(), /Next cursor: `next-page`/);
      } else {
        assert.equal(stdout.lines().length, 2);
        assert.deepEqual(JSON.parse(stdout.lines()[0]), {
          recordType: "audit_page",
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          generatedAt: response.generatedAt,
          staleBefore: response.staleBefore,
          nextCursor: "next-page",
        });
        assert.equal(JSON.parse(stdout.lines()[1]).target.project.displayName, "Project A");
      }
    }
  });

  it("invalid JSONはusage errorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["search", "--json", "{"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "WITHMATE_MEMORY_CLI_USAGE");
  });

  it("option value不足はusage errorで終了する", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["search", "--json"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
    });

    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.match(stdout.json().error.message, /--json requires a value/);
  });

  it("unknown commandは現行CLI surfaceを含むusage errorを返す", async () => {
    const stdout = createOutputCapture();
    const exitCode = await runWithMateMemoryCli(["nope"], {
      env: { WITHMATE_MEMORY_API_URL: "http://127.0.0.1:7777" },
      stdout: stdout.stream,
    });

    const message = stdout.json().error.message;
    assert.equal(exitCode, WITHMATE_MEMORY_CLI_EXIT_CODES.usage);
    assert.match(message, /schema\|validate/);
    assert.match(message, /@file/);
    assert.match(message, /--stdin/);
    assert.match(message, /--project/);
    assert.match(message, /--tag/);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "operator CLIは複数active候補を列挙でき、暗黙のlast-writer選択を行わない"
  // oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
  // failure_mode = "instances/status --allが一意性を確認せず後発runtimeへ接続する"
  // scope = "withmate-memory-cli-discovery"
  // lifecycle = "permanent"
  // @end-test-value
  it("instancesとstatus --allはactive候補をsafe metadataだけで列挙する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-cli-registry-"));
    const ids = [
      ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"],
    ] as const;
    const publications = [] as Array<{ unpublish(): Promise<boolean>; cleanupGeneration(): Promise<void> }>;
    try {
      for (const [applicationInstanceId, runtimeGenerationId] of ids) {
        const publication = await publishRuntimeDiscoveryEntry({
          rootDirectoryPath: root,
          security: async () => undefined,
          identity: { applicationInstanceId, runtimeKind: "memory", runtimeGenerationId },
          buildChannel: "development",
          process: { pid: 100, startedAt: "2026-08-30T00:00:00.000Z" },
          credentialDocuments: [{ adapterKind: "cli", document: {
            schemaVersion: "withmate-runtime-credential-v1",
            applicationInstanceId,
            runtimeKind: "memory",
            runtimeGenerationId,
            adapterKind: "cli",
            credential: {
              schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
              adapter: "cli",
              applicationInstanceId,
              runtimeGenerationId,
              runtimeInstanceId: runtimeGenerationId,
              baseUrl: "http://127.0.0.1:4567",
              apiSecret: "secret",
              adapterSecret: "operator-secret",
            },
          } }],
          clock: { now: () => new Date("2026-08-30T00:00:00.000Z") },
          timers: { setInterval: () => ({}) as ReturnType<typeof setInterval>, clearInterval: () => undefined },
        });
        publications.push(publication);
      }
      const env = {
        WITHMATE_MEMORY_REGISTRY_ROOT_DIRECTORY: root,
        WITHMATE_MEMORY_DISCOVERY_FILE: " ",
      };
      const output = createOutputCapture();
      assert.equal(await runWithMateMemoryCli(["instances"], {
        env,
        registryRootDirectoryPath: root,
        legacyDiscoveryFilePath: join(root, "none.json"),
        readFile: async () => { throw new Error("no legacy projection"); },
        stdout: output.stream,
      }), WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      const listed = output.json() as { instances: Array<Record<string, unknown>> };
      assert.equal(listed.instances.length, 2);
      assert.equal(JSON.stringify(listed).includes("secret"), false);
      const allOutput = createOutputCapture();
      assert.equal(await runWithMateMemoryCli(["status", "--all"], {
        env,
        registryRootDirectoryPath: root,
        legacyDiscoveryFilePath: join(root, "none.json"),
        readFile: async () => { throw new Error("no legacy projection"); },
        stdout: allOutput.stream,
      }), WITHMATE_MEMORY_CLI_EXIT_CODES.ok);
      assert.equal((allOutput.json() as { instances: unknown[] }).instances.length, 2);
    } finally {
      for (const publication of publications.reverse()) {
        await publication.unpublish();
        await publication.cleanupGeneration();
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
