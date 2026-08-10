import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
  SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
  buildSessionRuntimeDiscoveryGenerationFileName,
} from "../../src/session-runtime-discovery.js";
import { SESSION_RUNTIME_RESULT_SCHEMA_VERSION } from "../../src/session-external-runtime-contract.js";
import { createSessionRuntimeHttpServer } from "../../src-electron/session-runtime-http-server.js";
import {
  WITHMATE_SESSION_CLI_EXIT_CODES,
  WITHMATE_SESSION_CLI_SCHEMA_VERSION,
  runWithMateSessionCli,
} from "../withmate-session.js";
import {
  SessionRuntimeClientError,
  callSessionRuntime,
  discoverSessionRuntime,
  type SessionRuntimeConnection,
} from "../withmate-session-runtime-client.js";

const connection: SessionRuntimeConnection = {
  adapter: "cli",
  baseUrl: "http://127.0.0.1:4567",
  apiSecret: "api-secret",
  adapterSecret: "cli-secret",
  runtimeInstanceId: "runtime-1",
};

function capture() {
  let value = "";
  return {
    stream: { write(chunk: string) { value += chunk; } },
    text: () => value,
    json: () => JSON.parse(value.trim()) as Record<string, any>,
  };
}

describe("withmate-session CLI", () => {
  test("discovery pointerからCLI generationだけを解決する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "withmate-session-cli-"));
    const pointerPath = join(directory, "session.current.json");
    try {
      await writeFile(pointerPath, JSON.stringify({
        schemaVersion: SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
        runtimeInstanceId: "runtime-1",
      }));
      await writeFile(join(directory, buildSessionRuntimeDiscoveryGenerationFileName("cli", "runtime-1")), JSON.stringify({
        schemaVersion: SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
        adapter: "cli",
        baseUrl: connection.baseUrl,
        apiSecret: connection.apiSecret,
        adapterSecret: connection.adapterSecret,
        runtimeInstanceId: connection.runtimeInstanceId,
        publishedAt: "2026-08-11T00:00:00.000Z",
      }));

      assert.deepEqual(await discoverSessionRuntime({ discoveryFilePath: pointerPath, env: {} }), connection);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("identity mismatchではoperation bodyをdispatchしない", async () => {
    let operationRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/v1/status")) {
        const nonce = new URL(request.url, "http://127.0.0.1").searchParams.get("nonce") ?? "";
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          runtimeInstanceId: "different-runtime",
          challenge: {
            nonce,
            hmacSha256: createHmac("sha256", connection.apiSecret).update(`different-runtime\n${nonce}`).digest("base64url"),
          },
        }));
        return;
      }
      operationRequests += 1;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await assert.rejects(
        () => callSessionRuntime(
          { ...connection, baseUrl: `http://127.0.0.1:${port}` },
          { schemaVersion: "withmate-session-request-v1", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
          AbortSignal.timeout(2_000),
        ),
        (error) => error instanceof SessionRuntimeClientError && error.dispatched === false,
      );
      assert.equal(operationRequests, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("verified CLI connectionはversioned operationをSession runtimeへ送る", async () => {
    const received: unknown[] = [];
    const runtime = createSessionRuntimeHttpServer({
      apiSecret: connection.apiSecret,
      cliSecret: connection.adapterSecret,
      mcpSecret: "mcp-secret",
      runtimeInstanceId: connection.runtimeInstanceId,
      async handle(operation, input, adapter) {
        received.push({ operation, input, adapter });
        return {
          schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
          operation,
          result: { accepted: true },
        };
      },
    });
    await runtime.start();
    try {
      const port = runtime.address()?.port;
      assert.ok(port);
      const response = await callSessionRuntime(
        { ...connection, baseUrl: `http://127.0.0.1:${port}` },
        { schemaVersion: "withmate-session-request-v1", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
        AbortSignal.timeout(2_000),
      );

      assert.equal(response.ok, true);
      assert.deepEqual(received, [{
        operation: "turn.get",
        input: { sessionId: "s", executionId: "e" },
        adapter: "cli",
      }]);
    } finally {
      await runtime.stop();
    }
  });

  test("successを単一のversioned JSON documentとexit 0へ写像する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "turn", "get", "--json", JSON.stringify({ sessionId: "session-1", executionId: "execution-1" }),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async () => ({
        ok: true,
        status: 200,
        value: {
          schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
          operation: "turn.get",
          result: { id: "execution-1", state: "running" },
        },
      }),
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.equal(stdout.text().trim().split(/\r?\n/).length, 1);
    assert.equal(stdout.json().schemaVersion, WITHMATE_SESSION_CLI_SCHEMA_VERSION);
    assert.equal(stdout.json().ok, true);
  });

  test("application errorをsafe JSONとexit 3へ写像する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "turn", "cancel", "--json", JSON.stringify({ sessionId: "session-1", executionId: "missing" }),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async () => ({
        ok: false,
        status: 404,
        value: {
          schemaVersion: "withmate-session-error-v1",
          error: { code: "EXECUTION_NOT_FOUND", message: "Not found.", retryable: false, effect: "not_applied", details: {} },
        },
      }),
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.applicationError);
    assert.equal(stdout.json().error.code, "EXECUTION_NOT_FOUND");
    assert.equal(stdout.text().includes("api-secret"), false);
  });

  test("runtime未起動とdispatch後transport failureを別exit codeへ写像する", async () => {
    const unavailable = capture();
    assert.equal(await runWithMateSessionCli(["status"], {
      stdout: unavailable.stream,
      discover: async () => null,
    }), WITHMATE_SESSION_CLI_EXIT_CODES.runtimeUnavailable);
    assert.equal(unavailable.json().error.effect, "not_applied");

    const indeterminate = capture();
    assert.equal(await runWithMateSessionCli([
      "turn", "get", "--json", JSON.stringify({ sessionId: "session-1", executionId: "execution-1" }),
    ], {
      stdout: indeterminate.stream,
      discover: async () => connection,
      call: async () => { throw new SessionRuntimeClientError("lost", true); },
    }), WITHMATE_SESSION_CLI_EXIT_CODES.transportIndeterminate);
    assert.equal(indeterminate.json().error.effect, "indeterminate");
  });

  test("usage failureはoperationを呼ばずexit 1を返す", async () => {
    let called = false;
    const stdout = capture();
    const exitCode = await runWithMateSessionCli(["turn", "run"], {
      stdout: stdout.stream,
      discover: async () => { called = true; return connection; },
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(called, false);
    assert.equal(stdout.json().error.code, "INVALID_INPUT");
  });

  test("file input failureはprivate pathやraw Errorを出力しない", async () => {
    const stdout = capture();
    const privatePath = "C:\\private\\missing-request.json";
    const exitCode = await runWithMateSessionCli(["turn", "get", "--file", privatePath], {
      stdout: stdout.stream,
      read: async () => { throw new Error(`ENOENT: ${privatePath}`); },
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(stdout.text().includes(privatePath), false);
    assert.equal(stdout.text().includes("ENOENT"), false);
    assert.equal(stdout.json().error.message, "Operation input must be readable valid JSON.");
  });

  test("text formatはpublic projectionだけを要約する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli(["status", "--format", "text"], {
      stdout: stdout.stream,
      discover: async () => connection,
      verify: async () => true,
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.match(stdout.text(), /status: ok/);
    assert.equal(stdout.text().includes(connection.apiSecret), false);
    assert.equal(stdout.text().includes(connection.adapterSecret), false);
  });

  test("schemaはruntimeなしでcommandとexit codeを返す", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli(["schema"], { stdout: stdout.stream });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(stdout.json().result.exitCodes, WITHMATE_SESSION_CLI_EXIT_CODES);
    assert.ok(stdout.json().result.commands.includes("turn enqueue"));
  });

  test("mcp-server commandはstdio server entryへ委譲する", async () => {
    let starts = 0;
    const exitCode = await runWithMateSessionCli(["mcp-server"], {
      startMcp: async () => {
        starts += 1;
        return {} as any;
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.equal(starts, 1);
  });
});
