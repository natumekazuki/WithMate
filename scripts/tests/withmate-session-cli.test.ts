import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import {
  SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
  SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
  buildSessionRuntimeDiscoveryGenerationFileName,
} from "../../src/session-runtime-discovery.js";
import {
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  createSessionRuntimeChallenge,
} from "../../src/session-runtime-exchange.js";
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

  test("identity mismatchではcredentialとoperation bodyをdispatchしない", async () => {
    const observedHeaders: Array<Record<string, string | string[] | undefined>> = [];
    let observedBytes = 0;
    const server = createServer((request, response) => {
      observedHeaders.push(request.headers);
      request.on("data", (chunk) => { observedBytes += Buffer.byteLength(chunk); });
      response.writeHead(401, { "Content-Type": "application/json" });
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
      assert.equal(observedHeaders.length, 1);
      assert.equal(observedBytes, 0);
      assert.equal(observedHeaders[0]["x-withmate-session-api-secret"], undefined);
      assert.equal(observedHeaders[0]["x-withmate-session-adapter-secret"], undefined);
      assert.equal(observedHeaders[0]["content-length"], undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("challenge後に同じportのpeerが差し替わってもcredentialとoperationを再送しない", async () => {
    let replacementRequests = 0;
    let replacementServer: ReturnType<typeof createServer> | null = null;
    let replacementListening: Promise<void> | null = null;
    const firstHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const firstServer = createServer((request, response) => {
      firstHeaders.push(request.headers);
      const nonce = request.headers[SESSION_RUNTIME_NONCE_HEADER];
      response.writeEarlyHints({
        link: "</v1/operation>; rel=preconnect",
        [SESSION_RUNTIME_INSTANCE_HEADER]: connection.runtimeInstanceId,
        [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
          connection.apiSecret,
          connection.runtimeInstanceId,
          typeof nonce === "string" ? nonce : "",
        ),
      }, () => {
        request.socket.destroy();
        firstServer.close(() => {
          replacementServer = createServer((_request, replacementResponse) => {
            replacementRequests += 1;
            replacementResponse.end("{}");
          });
          replacementListening = listenServer(replacementServer, port).then(() => undefined);
        });
      });
    });
    const port = await listenServer(firstServer);
    try {
      await assert.rejects(
        () => callSessionRuntime(
          { ...connection, baseUrl: `http://127.0.0.1:${port}` },
          { schemaVersion: "withmate-session-request-v1", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
          AbortSignal.timeout(2_000),
        ),
        SessionRuntimeClientError,
      );
      if (replacementListening) await replacementListening;
      assert.equal(replacementRequests, 0);
      assert.equal(firstHeaders.length, 1);
      assert.equal(firstHeaders[0]["x-withmate-session-api-secret"], undefined);
      assert.equal(firstHeaders[0]["x-withmate-session-adapter-secret"], undefined);
      assert.equal(firstHeaders[0]["content-length"], undefined);
    } finally {
      await closeServer(firstServer);
      if (replacementListening) await replacementListening.catch(() => undefined);
      if (replacementServer) await closeServer(replacementServer);
    }
  });

  test("RL-01: response hard maximumを超えたpeer responseを全量受信せず拒否する", async () => {
    const server = createServer((request, response) => {
      const nonce = request.headers[SESSION_RUNTIME_NONCE_HEADER];
      response.writeEarlyHints({
        link: "</v1/operation>; rel=preconnect",
        [SESSION_RUNTIME_INSTANCE_HEADER]: connection.runtimeInstanceId,
        [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
          connection.apiSecret,
          connection.runtimeInstanceId,
          typeof nonce === "string" ? nonce : "",
        ),
      });
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("a".repeat(SESSION_RUNTIME_MAX_RESPONSE_BYTES + 1));
      });
    });
    const port = await listenServer(server);
    try {
      await assert.rejects(
        () => callSessionRuntime(
          { ...connection, baseUrl: `http://127.0.0.1:${port}` },
          { schemaVersion: "withmate-session-request-v1", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
          AbortSignal.timeout(2_000),
        ),
        (error) => error instanceof SessionRuntimeClientError
          && error.dispatched
          && /response exceeds 8 MiB/.test(error.message),
      );
    } finally {
      await closeServer(server);
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

  test("RUNTIME-CATALOG-02: runtime catalogはinput sourceなしで共通operationへdispatchする", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const exitCode = await runWithMateSessionCli(["runtime", "catalog"], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: {
            schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
            operation: "runtime.catalog",
            result: { revision: 7, providers: [] },
          },
        };
      },
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v1",
      operation: "runtime.catalog",
      input: {},
    }]);
    assert.deepEqual(stdout.json().result, {
      schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
      operation: "runtime.catalog",
      result: { revision: 7, providers: [] },
    });
  });

  test("session CRUD commandはdotted operationへ写像し、mutation keyを一度だけ補う", async () => {
    const requests: any[] = [];
    const stdout = capture();
    const exitCode = await runWithMateSessionCli(["session", "create", "--json", JSON.stringify({
      title: "Demo", provider: "codex", catalogRevision: 1, workspace: { kind: "session_folder" },
    })], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: { schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation: "session.create", result: { sessionId: "s1", title: "Demo" } } } as any;
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.equal(requests[0].operation, "session.create");
    assert.match(requests[0].input.idempotencyKey, /^[0-9a-f-]{36}$/);
  });

  test("session renameは明示idempotency keyを維持する", async () => {
    const stdout = capture();
    let request: any;
    const exitCode = await runWithMateSessionCli(["session", "rename", "--json", JSON.stringify({ sessionId: "s1", title: "Renamed", idempotencyKey: "fixed" })], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        request = envelope;
        return { ok: true, status: 200, value: { schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation: "session.rename", result: { sessionId: "s1", title: "Renamed" } } } as any;
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.equal(request.input.idempotencyKey, "fixed");
  });

  test("application errorをsafe JSONとexit 3へ写像する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "turn", "cancel", "--json", JSON.stringify({
        sessionId: "session-1",
        executionId: "missing",
        idempotencyKey: "cancel-missing",
      }),
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

  test("CLI-EFFECT-09: readのresponse lossはnot_applied、mutationだけindeterminateへ写像する", async () => {
    const unavailable = capture();
    assert.equal(await runWithMateSessionCli(["status"], {
      stdout: unavailable.stream,
      discover: async () => null,
    }), WITHMATE_SESSION_CLI_EXIT_CODES.runtimeUnavailable);
    assert.equal(unavailable.json().error.effect, "not_applied");

    const readFailure = capture();
    assert.equal(await runWithMateSessionCli([
      "turn", "get", "--json", JSON.stringify({ sessionId: "session-1", executionId: "execution-1" }),
    ], {
      stdout: readFailure.stream,
      discover: async () => connection,
      call: async () => { throw new SessionRuntimeClientError("lost", true); },
    }), WITHMATE_SESSION_CLI_EXIT_CODES.transportIndeterminate);
    assert.equal(readFailure.json().error.effect, "not_applied");

    const mutationFailure = capture();
    assert.equal(await runWithMateSessionCli([
      "turn", "cancel", "--json", JSON.stringify({
        sessionId: "session-1",
        executionId: "execution-1",
        idempotencyKey: "cancel-response-loss",
      }),
    ], {
      stdout: mutationFailure.stream,
      discover: async () => connection,
      call: async () => { throw new SessionRuntimeClientError("lost", true); },
    }), WITHMATE_SESSION_CLI_EXIT_CODES.transportIndeterminate);
    assert.equal(mutationFailure.json().error.effect, "indeterminate");
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

  test("CLI-INPUT-LIMIT-01: oversized file inputは全量parse前にCONTENT_TOO_LARGEへ収束する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "withmate-session-cli-input-"));
    const inputPath = join(directory, "oversized.json");
    try {
      await writeFile(inputPath, Buffer.alloc(SESSION_RUNTIME_MAX_BODY_BYTES + 1, 0x20));
      const stdout = capture();
      let discovered = false;
      const exitCode = await runWithMateSessionCli(["turn", "get", "--file", inputPath], {
        stdout: stdout.stream,
        discover: async () => {
          discovered = true;
          return connection;
        },
      });
      assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
      assert.equal(stdout.json().error.code, "CONTENT_TOO_LARGE");
      assert.equal(stdout.json().error.effect, "not_applied");
      assert.equal(discovered, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CLI-INPUT-LIMIT-01: oversized stdin inputはEOF前にCONTENT_TOO_LARGEへ収束する", async () => {
    const stdout = capture();
    const stdin = Readable.from([
      Buffer.alloc(SESSION_RUNTIME_MAX_BODY_BYTES, 0x20),
      Buffer.from(" "),
      Buffer.from("unread-tail"),
    ]);
    let discovered = false;
    const exitCode = await runWithMateSessionCli(["turn", "get", "--stdin"], {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout.stream,
      discover: async () => {
        discovered = true;
        return connection;
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "CONTENT_TOO_LARGE");
    assert.equal(stdout.json().error.effect, "not_applied");
    assert.equal(discovered, false);
  });

  test("CLI-INPUT-LIMIT-01: exchange envelope超過はnetwork dispatch前に拒否する", async () => {
    await assert.rejects(
      callSessionRuntime(
        { ...connection, baseUrl: "http://127.0.0.1:1" },
        {
          schemaVersion: "withmate-session-request-v1",
          operation: "turn.get",
          input: { payload: "a".repeat(SESSION_RUNTIME_MAX_BODY_BYTES) },
        },
        AbortSignal.timeout(2_000),
      ),
      (error) => error instanceof SessionRuntimeValidationError && error.code === "CONTENT_TOO_LARGE",
    );
  });

  test("CLI-INPUT-LIMIT-01: exchange envelope超過をpublic CLIでCONTENT_TOO_LARGEへ投影する", async () => {
    const emptyInput = JSON.stringify({ payload: "" });
    const input = JSON.stringify({
      payload: "a".repeat(SESSION_RUNTIME_MAX_BODY_BYTES - Buffer.byteLength(emptyInput, "utf8")),
    });
    assert.equal(Buffer.byteLength(input, "utf8"), SESSION_RUNTIME_MAX_BODY_BYTES);
    const stdout = capture();
    const exitCode = await runWithMateSessionCli(["turn", "get", "--json", input], {
      stdout: stdout.stream,
      discover: async () => connection,
      verify: async () => true,
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "CONTENT_TOO_LARGE");
    assert.equal(stdout.json().error.effect, "not_applied");
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
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
