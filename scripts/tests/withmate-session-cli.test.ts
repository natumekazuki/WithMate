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
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  createSessionRuntimeChallenge,
} from "../../src/session-runtime-exchange.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import {
  SESSION_RUNTIME_AGENT_OPERATION,
  createSessionRuntimeHttpServer,
} from "../../src-electron/session-runtime-http-server.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
} from "../../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  WITHMATE_SESSION_CLI_EXIT_CODES,
  WITHMATE_SESSION_CLI_SCHEMA_VERSION,
  resolveSessionCliTransportTimeoutMs,
  runWithMateSessionCli,
} from "../withmate-session.js";
import {
  SessionRuntimeClientError,
  callSessionRuntime,
  discoverSessionRuntime,
  resolveAgentRuntimeBindingReference,
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
  test("SESSION-SELF-CLIENT-01: provider bindingを解決しrequired marker欠落をfail closedにする", async () => {
    assert.equal(resolveAgentRuntimeBindingReference({
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: " opaque-reference ",
      [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
    }), "opaque-reference");
    assert.equal(resolveAgentRuntimeBindingReference({}), undefined);
    assert.throws(
      () => resolveAgentRuntimeBindingReference({
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
      }),
      /requires its runtime binding reference/i,
    );
    await assert.rejects(
      () => discoverSessionRuntime({
        env: { [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1" },
        discoveryFilePath: "unused",
      }),
      /requires its runtime binding reference/i,
    );
  });

  test("CLI-WAIT-TIMEOUT-01: wait transport timeoutはapplication waitより5秒長い", () => {
    assert.equal(resolveSessionCliTransportTimeoutMs("turn run", {
      responseMode: "wait",
      waitTimeoutMs: 300_000,
    }), 305_000);
    assert.equal(resolveSessionCliTransportTimeoutMs("turn run", { responseMode: "wait" }), 35_000);
    assert.equal(resolveSessionCliTransportTimeoutMs("turn run", {
      responseMode: "wait",
      waitTimeoutMs: 1_000,
    }), 35_000);
    assert.equal(resolveSessionCliTransportTimeoutMs("turn run", { responseMode: "deferred" }), 35_000);
    assert.equal(resolveSessionCliTransportTimeoutMs("interaction respond", {
      responseMode: "wait", waitTimeoutMs: 300_000,
    }), 305_000);
  });
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
          { schemaVersion: "withmate-session-request-v2", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
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
          { schemaVersion: "withmate-session-request-v2", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
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
          { schemaVersion: "withmate-session-request-v2", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
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
    const registry = new AgentRuntimeBindingRegistry();
    const binding = registry.issueOrReuse({
      actorSessionId: "session-actor",
      providerId: "codex",
      operationGrants: [SESSION_RUNTIME_AGENT_OPERATION],
    });
    const runtime = createSessionRuntimeHttpServer({
      apiSecret: connection.apiSecret,
      cliSecret: connection.adapterSecret,
      mcpSecret: "mcp-secret",
      runtimeInstanceId: connection.runtimeInstanceId,
      agentRuntimeBindingRegistry: registry,
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
        {
          ...connection,
          baseUrl: `http://127.0.0.1:${port}`,
          agentRuntimeBindingReference: binding.bindingReference,
        },
        { schemaVersion: "withmate-session-request-v2", operation: "turn.get", input: { sessionId: "s", executionId: "e" } },
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
      schemaVersion: "withmate-session-request-v2",
      operation: "runtime.catalog",
      input: {},
    }]);
    assert.deepEqual(stdout.json().result, {
      schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
      operation: "runtime.catalog",
      result: { revision: 7, providers: [] },
    });
  });

  test("SESSION-SELF-02: session selfはinput sourceなしで共通operationへdispatchする", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const exitCode = await runWithMateSessionCli(["session", "self"], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("session.self", { sessionId: "session-actor" }),
        };
      },
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "session.self",
      input: {},
    }]);
    assert.deepEqual(stdout.json().result.result, { sessionId: "session-actor" });
  });

  test("COORD-ADAPTER-01: coordination event createは共通operationへdispatchする", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = { kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" };
    const exitCode = await runWithMateSessionCli([
      "coordination", "event", "create", "--json", JSON.stringify(input),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("coordination.event.create", { eventId: "event-1" } as never),
        };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "coordination.event.create",
      input,
    }]);
  });

  test("WORK-ADAPTER-01: work resultはshared strict inputへdispatchする", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = {
      workItemId: "work-1",
      state: "completed",
      expectedRevision: 2,
      result: {
        summary: "done",
        changes: [],
        verificationResults: [],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
      },
      idempotencyKey: "work-result-key",
    };
    const exitCode = await runWithMateSessionCli(["work", "result", "--json", JSON.stringify(input)], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: createSessionRuntimeResult("work.result", {} as never) };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "work.result",
      input,
    }]);
  });

  test("COORD-RESOLVE-SURFACE-01: agentはCLIでも回答optionなしでblockerを解決できる", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = { eventId: "blocker-1", idempotencyKey: "resolve-blocker-1" };
    const exitCode = await runWithMateSessionCli([
      "coordination", "event", "resolve", "--json", JSON.stringify(input),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("coordination.event.resolve", { eventId: "blocker-1" } as never),
        };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "coordination.event.resolve",
      input,
    }]);
  });

  test("COORD-CONSUME-01: agentは反映済みのユーザー回答をCLIからconsumeできる", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = { eventId: "decision-1", expectedResolutionSequence: 3, idempotencyKey: "consume-decision-1" };
    const exitCode = await runWithMateSessionCli([
      "coordination", "event", "consume", "--json", JSON.stringify(input),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("coordination.event.consume", { eventId: "decision-1" } as never),
        };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "coordination.event.consume",
      input,
    }]);
  });

  test("session CRUD commandはcaller-owned idempotency keyを必須にする", async () => {
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
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(stdout.json().error.code, "INVALID_INPUT");
    assert.deepEqual(requests, []);
  });

  test("TURN-OPTIONS: turn optionsはread-onlyの共通operationへdispatchする", async () => {
    const requests: unknown[] = [];
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "turn", "options", "--json", JSON.stringify({ sessionId: "session-1" }),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: {
            schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
            operation: "turn.options",
            result: { sessionId: "session-1", catalogRevision: 9, models: [] },
          },
        } as any;
      },
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "turn.options",
      input: { sessionId: "session-1" },
    }]);
    assert.equal(stdout.json().result.operation, "turn.options");
  });

  test("EXT-INTERACTION-11: interaction respondをshared exact inputへdispatchする", async () => {
    const requests: any[] = [];
    const stdout = capture();
    const input = {
      sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
      response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-1", responseMode: "deferred",
    };
    const exitCode = await runWithMateSessionCli([
      "interaction", "respond", "--json", JSON.stringify(input),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: createSessionRuntimeResult("interaction.respond", {} as never) };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests[0], {
      schemaVersion: "withmate-session-request-v2", operation: "interaction.respond", input,
    });
  });

  test("EXT-TRANSCRIPT-13: transcript exportをshared exact inputへdispatchする", async () => {
    const requests: any[] = [];
    const stdout = capture();
    const input = {
      sessionId: "session-1", format: "json", maxBytes: 1024,
      destination: { kind: "inline" },
    };
    const exitCode = await runWithMateSessionCli([
      "transcript", "export", "--json", JSON.stringify(input),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: createSessionRuntimeResult("transcript.export", {
          destination: "inline", format: "json", byteLength: 2, content: "{}",
        }) } as any;
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests[0], {
      schemaVersion: "withmate-session-request-v2", operation: "transcript.export", input,
    });
  });

  test("EXT-TRANSCRIPT-13: inlineはresponse lossをnot_applied、SessionFolderはindeterminateにする", async () => {
    for (const [destination, expectedEffect] of [
      [{ kind: "inline" }, "not_applied"],
      [{ kind: "session_folder", relativePath: "transcript.json", replace: false, idempotencyKey: "export-1" }, "indeterminate"],
    ] as const) {
      const stdout = capture();
      const exitCode = await runWithMateSessionCli(["transcript", "export", "--json", JSON.stringify({
        sessionId: "session-1", format: "json", maxBytes: 1024, destination,
      })], {
        stdout: stdout.stream,
        discover: async () => connection,
        call: async () => { throw new SessionRuntimeClientError("response lost", true); },
      });
      assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.transportIndeterminate);
      assert.equal(stdout.json().error.effect, expectedEffect);
    }
  });

  test("EXT-PROVIDER-02: Copilot Session作成とTurn実行をprovider固有schemaでdispatchする", async () => {
    const requests: any[] = [];
    const stdout = capture();
    const call = async (_connection: unknown, envelope: any) => {
      requests.push(envelope);
      if (envelope.operation === "session.create") {
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("session.create", { sessionId: "copilot-session", title: "Copilot" }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        value: createSessionRuntimeResult(envelope.operation, {
          id: "execution-1",
          sessionId: "copilot-session",
          operation: envelope.operation,
          state: "queued",
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          result: null,
          errorCode: null,
          errorMessage: null,
          interruptedReason: null,
        }),
      } as any;
    };

    assert.equal(await runWithMateSessionCli([
      "session", "create", "--json", JSON.stringify({
        sessionRole: "executor",
        title: "Copilot",
        provider: "copilot",
        catalogRevision: 5,
        workspace: { kind: "session_folder" },
        idempotencyKey: "create-copilot",
      }),
    ], { stdout: stdout.stream, discover: async () => connection, call: call as any }), WITHMATE_SESSION_CLI_EXIT_CODES.ok);

    const turn = {
      provider: "copilot",
      userMessage: "hello",
      model: "claude-sonnet",
      reasoningEffort: "high",
      approvalMode: "on-request",
      customAgentName: "reviewer",
      attachments: [],
    };
    assert.equal(await runWithMateSessionCli([
      "turn", "run", "--json", JSON.stringify({
        sessionId: "copilot-session",
        catalogRevision: 5,
        idempotencyKey: "run-copilot",
        responseMode: "deferred",
        terminalFailureNotification: { targetSessionId: "target-session" },
        turn,
      }),
    ], { stdout: stdout.stream, discover: async () => connection, call: call as any }), WITHMATE_SESSION_CLI_EXIT_CODES.ok);

    assert.deepEqual(requests.map((request) => [request.operation, request.input.provider ?? request.input.turn?.provider]), [
      ["session.create", "copilot"],
      ["turn.run", "copilot"],
    ]);
    assert.deepEqual(requests[1].input.terminalFailureNotification, { targetSessionId: "target-session" });

    const invalid = capture();
    assert.equal(await runWithMateSessionCli([
      "turn", "enqueue", "--json", JSON.stringify({
        sessionId: "copilot-session",
        catalogRevision: 5,
        idempotencyKey: "mixed-provider-fields",
        turn: { ...turn, codexSandboxMode: "workspace-write" },
      }),
    ], { stdout: invalid.stream, discover: async () => connection, call: call as any }), WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(invalid.json().error.code, "INVALID_INPUT");
    assert.equal(requests.length, 2);

    const invalidNotification = capture();
    assert.equal(await runWithMateSessionCli([
      "turn", "enqueue", "--json", JSON.stringify({
        sessionId: "copilot-session",
        catalogRevision: 5,
        idempotencyKey: "invalid-notification",
        terminalFailureNotification: { targetSessionId: "target-session", characterId: "spoof" },
        turn,
      }),
    ], {
      stdout: invalidNotification.stream,
      discover: async () => connection,
      call: call as any,
    }), WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.equal(invalidNotification.json().error.code, "INVALID_INPUT");
    assert.equal(requests.length, 2);
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

  test("SF-ADAPTER-03: session files commandをshared operationへ変換する", async () => {
    const stdout = capture();
    let request: any;
    const exitCode = await runWithMateSessionCli([
      "session", "files", "write-text", "--json", JSON.stringify({
        sessionId: "s1",
        relativePath: "notes/brief.md",
        content: "hello",
        idempotencyKey: "write-1",
      }),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        request = envelope;
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("session.files.write_text", { file: { relativePath: "notes/brief.md" } }),
        } as any;
      },
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.equal(request.operation, "session.files.write_text");
    assert.deepEqual(request.input, {
      sessionId: "s1",
      relativePath: "notes/brief.md",
      content: "hello",
      maxBytes: 1024 * 1024,
      replace: false,
      idempotencyKey: "write-1",
    });
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
          schemaVersion: "withmate-session-error-v2",
          error: { code: "EXECUTION_NOT_FOUND", message: "Not found.", retryable: false, effect: "not_applied", details: {} },
        },
      }),
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.applicationError);
    assert.equal(stdout.json().error.code, "EXECUTION_NOT_FOUND");
    assert.equal(stdout.text().includes("api-secret"), false);
  });

  test("APPLIED-ID-01: text errorもapplied resource IDを保持する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "session", "create", "--format", "text", "--json", JSON.stringify({
        sessionRole: "executor",
        title: "Large projection",
        provider: "codex",
        catalogRevision: 1,
        workspace: { kind: "session_folder" },
        idempotencyKey: "create-large-projection",
      }),
    ], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async () => ({
        ok: false,
        status: 413,
        value: {
          schemaVersion: "withmate-session-error-v2",
          error: {
            code: "CONTENT_TOO_LARGE",
            message: "Projection too large.",
            retryable: false,
            effect: "applied",
            details: { sessionId: "session-created" },
          },
        },
      }),
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.applicationError);
    assert.match(stdout.text(), /"effect": "applied"/);
    assert.match(stdout.text(), /"sessionId": "session-created"/);
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

    const fileMutationFailure = capture();
    assert.equal(await runWithMateSessionCli([
      "session", "files", "write-text", "--json", JSON.stringify({
        sessionId: "session-1",
        relativePath: "brief.md",
        content: "hello",
        idempotencyKey: "write-response-loss",
      }),
    ], {
      stdout: fileMutationFailure.stream,
      discover: async () => connection,
      call: async () => { throw new SessionRuntimeClientError("lost", true); },
    }), WITHMATE_SESSION_CLI_EXIT_CODES.transportIndeterminate);
    assert.equal(fileMutationFailure.json().error.effect, "indeterminate");
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

  test("usageはcoordination event consumeを案内する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli(["unknown"], {
      stdout: stdout.stream,
      discover: async () => connection,
    });

    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.usage);
    assert.match(stdout.json().error.message, /coordination event create\|list\|get\|resolve\|consume\|cancel\|correct/);
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
          schemaVersion: "withmate-session-request-v2",
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
