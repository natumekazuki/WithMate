import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import {
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER,
  SESSION_RUNTIME_GENERATION_HEADER,
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
  SessionRuntimeDiscoveryError,
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
  applicationInstanceId: "11111111-1111-4111-8111-111111111111",
  runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function capture() {
  let value = "";
  return {
    stream: { write(chunk: string) { value += chunk; } },
    text: () => value,
    json: () => JSON.parse(value.trim()) as Record<string, any>,
  };
}

function publicExecutionResult() {
  return {
    id: "execution-1",
    revision: 1,
    sessionId: "session-1",
    operation: "turn.run" as const,
    state: "completed" as const,
    result: { assistantText: "accepted" },
    errorCode: "",
    reason: "",
    createdAt: "2026-08-11T00:00:00.000Z",
    admittedAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-11T00:00:01.000Z",
    updatedAt: "2026-08-11T00:00:01.000Z",
    effectiveTurn: null,
    attachments: [],
    pendingInteraction: null,
    partialOutput: null,
    terminalFailureNotification: null,
    workItemId: null,
  };
}

describe("withmate-session CLI", () => {
  // @test-value v1
  // kind = "security"
  // claim = "provider binding required markerがあるclientはbinding reference欠落時にdiscovery前でfail closedする"
  // oracle = { type = "adr", ref = "ADR-023 Selection and binding" }
  // failure_mode = "provider-bound clientがbinding referenceなしでoperator相当のSession runtime接続へdowngradeする"
  // scope = "withmate-session-client-binding-admission"
  // lifecycle = "permanent"
  // @end-test-value
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
      }),
      /requires its runtime binding reference/i,
    );
  });

  // @test-value v1
  // kind = "contract"
  // claim = "unbound CLIは複数active Session runtimeを暗黙選択せずRUNTIME_AMBIGUOUSとexit 2へ投影する"
  // oracle = { type = "adr", ref = "ADR-023 Selection and binding" }
  // failure_mode = "複数runtimeの一つを起動順で選ぶか、ambiguityをusage errorとして誤分類する"
  // scope = "withmate-session-cli-discovery-error-projection"
  // lifecycle = "permanent"
  // @end-test-value
  test("unbound CLIはambiguous discoveryをruntime unavailable classへ投影する", async () => {
    const output = capture();
    const exitCode = await runWithMateSessionCli(["status"], {
      stdout: output.stream,
      discover: async () => { throw new SessionRuntimeDiscoveryError("runtime_ambiguous"); },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.runtimeUnavailable);
    assert.equal(output.json().error.code, "RUNTIME_AMBIGUOUS");
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

  // @test-value v1
  // kind = "security"
  // claim = "identity challenge後にpeerが切断されてもcredentialとoperation bodyを別peerへ再送しない"
  // oracle = { type = "adr", ref = "ADR-023 Diagnostics and security" }
  // failure_mode = "challenge後の接続差し替えへsecret-bearing bodyを自動再送する"
  // scope = "withmate-session-authenticated-http-client"
  // lifecycle = "permanent"
  // @end-test-value
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
        [SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER]: connection.applicationInstanceId,
        [SESSION_RUNTIME_GENERATION_HEADER]: connection.runtimeGenerationId,
        [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
          connection.apiSecret,
          connection.applicationInstanceId,
          connection.runtimeGenerationId,
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

  // @test-value v1
  // kind = "invariant"
  // claim = "Session runtime clientはresponse hard maximum超過を拒否しdispatch済み状態を保持する"
  // oracle = { type = "contract", ref = "SESSION_RUNTIME_MAX_RESPONSE_BYTES" }
  // failure_mode = "oversized responseを無制限に受信するか、dispatch済みmutationを未送信として扱う"
  // scope = "withmate-session-runtime-response-limit"
  // lifecycle = "permanent"
  // @end-test-value
  test("RL-01: response hard maximumを超えたpeer responseを全量受信せず拒否する", async () => {
    const server = createServer((request, response) => {
      const nonce = request.headers[SESSION_RUNTIME_NONCE_HEADER];
      response.writeEarlyHints({
        link: "</v1/operation>; rel=preconnect",
        [SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER]: connection.applicationInstanceId,
        [SESSION_RUNTIME_GENERATION_HEADER]: connection.runtimeGenerationId,
        [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
          connection.apiSecret,
          connection.applicationInstanceId,
          connection.runtimeGenerationId,
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

  // @test-value v1
  // kind = "security"
  // claim = "raw Session Runtime clientはidentity検証後もstrict public schemaにないfieldを含むresponseを受理しない"
  // oracle = { type = "contract", ref = "AUTONOMY-PARITY-08" }
  // failure_mode = "認証済みpeerの私有field混入responseをCLIが成功として公開する"
  // scope = "withmate-session-runtime-client public response admission"
  // lifecycle = "permanent"
  // distinction = "byte上限やidentity mismatchではなく、dispatch後に届く上限内JSONのpublic schema違反を観測する"
  // @end-test-value
  test("AUTONOMY-PARITY-08: raw clientは私有fieldを含むpublic responseを拒否する", async () => {
    const server = createServer((request, response) => {
      const nonce = request.headers[SESSION_RUNTIME_NONCE_HEADER];
      response.writeEarlyHints({
        link: "</v1/operation>; rel=preconnect",
        [SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER]: connection.applicationInstanceId,
        [SESSION_RUNTIME_GENERATION_HEADER]: connection.runtimeGenerationId,
        [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
          connection.apiSecret,
          connection.applicationInstanceId,
          connection.runtimeGenerationId,
          typeof nonce === "string" ? nonce : "",
        ),
      });
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ...createSessionRuntimeResult("turn.get", publicExecutionResult()),
          privateMarker: "must-not-leak",
        }));
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
          && /invalid public response/.test(error.message),
      );
    } finally {
      await closeServer(server);
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "application instanceとgenerationを検証したCLI connectionはversioned operationをSession runtimeへ送る"
  // oracle = { type = "adr", ref = "ADR-023 Selection and binding" }
  // failure_mode = "正しいidentity tupleのconnectionがdispatch不能になるか、未検証peerへoperationを送る"
  // scope = "withmate-session-cli-runtime-integration"
  // lifecycle = "permanent"
  // @end-test-value
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
      applicationInstanceId: connection.applicationInstanceId,
      runtimeGenerationId: connection.runtimeGenerationId,
      agentRuntimeBindingRegistry: registry,
      async handle(operation, input, adapter) {
        received.push({ operation, input, adapter });
        return {
          schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
          operation,
          result: publicExecutionResult(),
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

  // @test-value v1
  // kind = "contract"
  // claim = "CLI coordination createはactor container revisionを失わずshared strict inputへ渡す"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "CLIだけexpectedContainerRevisionを欠落させstale containerへのcreateを許す"
  // scope = "withmate-session-cli-coordination-create"
  // lifecycle = "permanent"
  // @end-test-value
  test("COORD-ADAPTER-01: coordination event createは共通operationへdispatchする", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = { expectedContainerRevision: 1, kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" };
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

  test("AGG-ADAPTER-01: work aggregation retryはshared strict inputへdispatchする", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = {
      parentWorkItemId: "work-parent", childWorkItemId: "work-child", targetSessionId: "session-2",
      goal: "retry", scope: "scope", completionCriteria: "done", authority: "local",
      sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
      expectedAggregateRevision: 2, idempotencyKey: "retry-key",
    };
    const exitCode = await runWithMateSessionCli(["work", "aggregation", "retry", "--json", JSON.stringify(input)], {
      stdout: stdout.stream,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: createSessionRuntimeResult("work.aggregation.retry", {} as never) };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok);
    assert.deepEqual(requests, [{ schemaVersion: "withmate-session-request-v2", operation: "work.aggregation.retry", input }]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "CLI coordination resolveはcurrent event revisionをshared strict inputへ渡す"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "CLIだけexpectedRevisionを欠落させstale blockerを解決する"
  // scope = "withmate-session-cli-coordination-resolve"
  // lifecycle = "permanent"
  // @end-test-value
  test("COORD-RESOLVE-SURFACE-01: agentはCLIでも回答optionなしでblockerを解決できる", async () => {
    const stdout = capture();
    const requests: unknown[] = [];
    const input = { eventId: "blocker-1", expectedRevision: 0, idempotencyKey: "resolve-blocker-1" };
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

  // @test-value v1
  // kind = "security"
  // claim = "CLI interaction responseは対象interactionのexpected revisionをshared boundaryへ渡す"
  // oracle = { type = "contract", ref = "AUTONOMY-USER-01" }
  // failure_mode = "CLI adapterがrevisionを落としstaleな回答をcurrent user decisionとして送る"
  // scope = "withmate-session-cli-interaction-respond"
  // lifecycle = "permanent"
  // @end-test-value
  test("EXT-INTERACTION-11: interaction respondをshared exact inputへdispatchする", async () => {
    const requests: any[] = [];
    const stdout = capture();
    const input = {
      sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
      expectedRevision: 1,
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

  // @test-value v1
  // kind = "contract"
  // claim = "Copilot Session/Turn createはexpected container revisionとprovider固有tupleを保持する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "provider別CLI経路だけSessionまたはtarget container revisionを欠落させる"
  // scope = "withmate-session-cli-copilot-create-and-turn"
  // lifecycle = "permanent"
  // @end-test-value
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
          revision: 1,
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
        expectedContainerRevision: 1,
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
        expectedContainerRevision: 1,
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
    assert.equal(requests[1].input.expectedContainerRevision, 1);

    const invalid = capture();
    assert.equal(await runWithMateSessionCli([
      "turn", "enqueue", "--json", JSON.stringify({
        expectedContainerRevision: 2,
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
        expectedContainerRevision: 2,
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

  // @test-value v1
  // kind = "contract"
  // claim = "CLI Session renameはcurrent revisionとcaller-owned idempotency keyを保持する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "CLI renameがexpectedRevisionを落としlost updateを許す"
  // scope = "withmate-session-cli-session-rename"
  // lifecycle = "permanent"
  // @end-test-value
  test("session renameは明示idempotency keyを維持する", async () => {
    const stdout = capture();
    let request: any;
    const exitCode = await runWithMateSessionCli(["session", "rename", "--json", JSON.stringify({ sessionId: "s1", expectedRevision: 1, title: "Renamed", idempotencyKey: "fixed" })], {
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

  // @test-value v1
  // kind = "contract"
  // claim = "revision付きcancelのapplication errorはsafe JSONとapplication error exit codeへ写像される"
  // oracle = { type = "contract", ref = "docs/runbooks/session-cli.md#Exit codes" }
  // failure_mode = "CLIがAPI errorをargument errorへ誤分類するかsecretを標準出力へ漏らす"
  // scope = "withmate-session CLI application error mapping"
  // lifecycle = "permanent"
  // @end-test-value
  test("application errorをsafe JSONとexit 3へ写像する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "turn", "cancel", "--json", JSON.stringify({
        sessionId: "session-1",
        executionId: "missing",
        expectedRevision: 1,
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

  // @test-value v1
  // kind = "contract"
  // claim = "revision付きSession createでもapplied errorのresource identityをtext出力へ保持する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "expectedContainerRevision追加後にapplied resultのreconciliation identityを失う"
  // scope = "withmate-session-cli-applied-create-error"
  // lifecycle = "permanent"
  // @end-test-value
  test("APPLIED-ID-01: text errorもapplied resource IDを保持する", async () => {
    const stdout = capture();
    const exitCode = await runWithMateSessionCli([
      "session", "create", "--format", "text", "--json", JSON.stringify({
        expectedContainerRevision: 1,
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

  // @test-value v1
  // kind = "contract"
  // claim = "response lossはreadでnot_applied、revision付きmutationでindeterminateとして公開される"
  // oracle = { type = "contract", ref = "docs/runbooks/session-cli.md#Exit codes" }
  // failure_mode = "readを適用不明と誤報するか、cancelの適用可能性を未適用として安全でないretryを促す"
  // scope = "withmate-session CLI transport effect mapping"
  // lifecycle = "permanent"
  // @end-test-value
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
        expectedRevision: 1,
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
