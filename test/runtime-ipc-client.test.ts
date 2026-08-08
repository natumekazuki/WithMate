import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectCliOperationOutput } from "../src/cli/application-response.js";
import { CLI_EXIT_CODES, type CliValidatedCommand, type CliValidatedRunCommand } from "../src/cli/contract.js";
import { projectCliRunOperationOutput } from "../src/cli/run-output.js";
import type { OwnedRuntimeApplication } from "../src/main/runtime-application.js";
import { createRuntimeApplicationClient } from "../src/main/runtime-host/runtime-application-client.js";
import {
  decodeRuntimeIpcEnvelope,
  encodeRuntimeIpcEnvelope,
  RUNTIME_IPC_OPERATIONS,
  type RuntimeIpcEnvelope,
  type RuntimeIpcOperation,
  type RuntimeIpcOperationPayload,
} from "../src/main/runtime-host/runtime-ipc-contract.js";
import { RUNTIME_IPC_PROTOCOL_VERSION } from "../src/main/runtime-host/runtime-ipc-common.js";
import {
  RuntimeIpcClient,
  RuntimeIpcClientError,
  RuntimeIpcRemoteError,
} from "../src/main/runtime-host/runtime-ipc-client.js";
import {
  RuntimeEndpointUnavailableError,
  type RuntimeEndpointConnection,
} from "../src/main/runtime-host/runtime-endpoint.js";
import {
  RuntimeHostAlreadyRunningError,
  startRuntimeHost,
  type RuntimeHost,
  type RuntimeHostDependencies,
} from "../src/main/runtime-host/runtime-host.js";

function providerSettings(reasoningEffort = "medium") {
  return {
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    settings: {
      model: "gpt-test",
      reasoningEffort,
      approvalPolicy: "never",
      sandbox: { mode: "workspace-write", networkAccess: false },
    },
  } as const;
}
import {
  startRuntimeHostClient,
  type RuntimeHostBootstrapDependencies,
} from "../src/main/runtime-host/runtime-host-bootstrap.js";
import {
  resolveRuntimeOwnerIdentity,
  type RuntimeOwnerIdentity,
} from "../src/main/runtime-host/runtime-owner-identity.js";
import { acquireRuntimeOwnerClaim } from "../src/main/runtime-host/runtime-owner-claim.js";
import { connectRuntimeEndpoint, createRuntimeEndpointListener } from "../src/main/runtime-host/runtime-endpoint.js";

const LOCAL_AUTHORIZATION = Object.freeze({
  transport: "local_cli",
  principal: "current_os_user",
} as const);

test("runtime IPC client correlates concurrent responses that complete out of order", async (context) => {
  const statusCalls = new Set<string>();
  const fixture = await createHostFixture(context, {
    status: (request) => {
      const runId = request.runId as string;
      statusCalls.add(runId);
      return statusRequests.get(runId)?.promise ?? Promise.reject(new Error("Unexpected run."));
    },
  });
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const statusRequests = new Map([
    ["run-1", first],
    ["run-2", second],
  ]);
  const client = await RuntimeIpcClient.connect(fixture.identity, { timeoutMs: 2_000 });
  context.after(() => client.close().catch(() => undefined));

  const firstRequest = client.request("run.status", { sessionId: "session-1", runId: "run-1" });
  const secondRequest = client.request("run.status", { sessionId: "session-1", runId: "run-2" });
  await waitFor(() => statusCalls.size === 2);
  second.resolve(readResponse(runStatus("run-2")));
  first.resolve(readResponse(runStatus("run-1")));

  assert.equal(valueRunId(await secondRequest), "run-2");
  assert.equal(valueRunId(await firstRequest), "run-1");
});

test("runtime IPC client cancels client-scoped waits, never cancels durable writes, and ignores late responses", async (context) => {
  let followSignal: AbortSignal | undefined;
  let writeSignal: AbortSignal | undefined;
  let startSignal: AbortSignal | undefined;
  let cancelSignal: AbortSignal | undefined;
  let interactionSignal: AbortSignal | undefined;
  let writeCalls = 0;
  let startCalls = 0;
  let cancelCalls = 0;
  let interactionCalls = 0;
  const durable = deferred<unknown>();
  const durableStart = deferred<unknown>();
  const durableCancel = deferred<unknown>();
  const durableInteraction = deferred<unknown>();
  const fixture = await createHostFixture(context, {
    follow: async (_request, options) => {
      followSignal = options?.signal;
      return await rejectWhenAborted(options?.signal);
    },
    updateTitle: async (_request, options) => {
      writeCalls += 1;
      writeSignal = options?.signal;
      return await durable.promise;
    },
    start: async (_request, options) => {
      startCalls += 1;
      startSignal = options?.signal;
      return await durableStart.promise;
    },
    cancel: async (_request, options) => {
      cancelCalls += 1;
      cancelSignal = options?.signal;
      return await durableCancel.promise;
    },
    respondInteraction: async (_request, options) => {
      interactionCalls += 1;
      interactionSignal = options?.signal;
      return await durableInteraction.promise;
    },
    list: async () => readResponse({ items: [] }),
  });
  const client = await RuntimeIpcClient.connect(fixture.identity, { timeoutMs: 2_000 });
  context.after(() => client.close().catch(() => undefined));

  await assert.rejects(
    client.request(
      "run.follow",
      { sessionId: "session-1", runId: "run-1", limit: 1, waitMs: 1_000, pollMs: 25 },
      { timeoutMs: 25 },
    ),
    (error: unknown) => error instanceof RuntimeIpcClientError && error.code === "request_timeout",
  );
  await waitFor(() => followSignal?.aborted === true);

  await assert.rejects(
    client.request(
      "session.update_title",
      { sessionId: "session-1", idempotencyKey: randomUUID(), title: "Renamed" },
      { timeoutMs: 25 },
    ),
    (error: unknown) => error instanceof RuntimeIpcClientError && error.code === "request_timeout",
  );
  assert.equal(writeCalls, 1);
  assert.equal(writeSignal?.aborted, false);
  durable.resolve(writeResponse({ sessionId: "session-1", title: "Renamed", updatedAt: 2 }));
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    client.request(
      "run.respond_interaction",
      {
        sessionId: "session-1",
        runId: "run-1",
        idempotencyKey: randomUUID(),
        response: { interactionId: "interaction-1", kind: "provider.approval", payload: { decision: "accept" } },
      },
      { timeoutMs: 25 },
    ),
    (error: unknown) => error instanceof RuntimeIpcClientError && error.code === "request_timeout",
  );
  assert.equal(interactionCalls, 1);
  assert.equal(interactionSignal?.aborted, false);
  durableInteraction.resolve(writeResponse(respondInteractionValue()));
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    client.request(
      "run.start",
      {
        sessionId: "session-1",
        idempotencyKey: randomUUID(),
        contentBlocks: [{ type: "text", text: "hello" }],
        providerSettings: providerSettings(),
      },
      { timeoutMs: 25 },
    ),
    (error: unknown) => error instanceof RuntimeIpcClientError && error.code === "request_timeout",
  );
  assert.equal(startCalls, 1);
  assert.equal(startSignal?.aborted, false);
  durableStart.resolve(writeResponse({ sessionId: "session-1", runId: "run-new", phase: "queued" }));
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    client.request(
      "run.cancel",
      { sessionId: "session-1", runId: "run-1", idempotencyKey: randomUUID() },
      { timeoutMs: 25 },
    ),
    (error: unknown) => error instanceof RuntimeIpcClientError && error.code === "request_timeout",
  );
  assert.equal(cancelCalls, 1);
  assert.equal(cancelSignal?.aborted, false);
  durableCancel.resolve(
    writeResponse({
      sessionId: "session-1",
      runId: "run-1",
      phase: "canceling",
      liveActivity: null,
      createdAt: 1,
      updatedAt: 2,
      cancellation: { requestedAt: 2 },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const read = await client.request("session.list", { limit: 1 });
  assertJsonEqual(read, readResponse({ items: [] }));
  assert.equal(writeCalls, 1);
  assert.equal(startCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(interactionCalls, 1);
});

test("a queued request timeout remains not-started and a connection loss settles the sent sibling", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-client-queued-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const transport = queuedWriteTransport();
  const client = await RuntimeIpcClient.connect(identity, {
    timeoutMs: 2_000,
    connect: async () => transport.connection,
  });
  context.after(() => client.close().catch(() => undefined));

  const sent = client.request("session.list", { limit: 1 });
  await waitFor(() => transport.envelopes.some((envelope) => envelope.kind === "request"));
  const queued = client.request("session.list_local_repositories", { limit: 1 }, { timeoutMs: 20 });
  await assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof RuntimeIpcClientError && error.code === "request_timeout" && error.execution === "not_started",
  );

  transport.disconnect();
  await assert.rejects(
    sent,
    (error: unknown) =>
      error instanceof RuntimeIpcClientError && error.code === "connection_closed" && error.execution === "unknown",
  );
  assert.deepEqual(
    transport.envelopes.map((envelope) => envelope.kind),
    ["handshake_request", "request"],
  );
});

test("runtime Application client closes only its connection and a later client keeps using the same host generation", async (context) => {
  const pendingInteractions = readResponse({
    sessionId: "session-1",
    runId: "run-1",
    runVersion: 7,
    interactions: [interactionSnapshot("interaction-1")],
  });
  const fixture = await createHostFixture(context, {
    list: async () => readResponse({ items: [] }),
    interactions: async () => pendingInteractions,
  });
  const firstClient = await RuntimeIpcClient.connect(fixture.identity, { timeoutMs: 2_000 });
  const firstRuntime = createRuntimeApplicationClient(firstClient);
  assertJsonEqual(
    await firstRuntime.operations.list({ context: { authorization: LOCAL_AUTHORIZATION }, limit: 1 }),
    readResponse({ items: [] }),
  );
  assertJsonEqual(
    await firstRuntime.runOperations.interactions({
      context: { authorization: LOCAL_AUTHORIZATION },
      sessionId: "session-1",
      runId: "run-1",
    }),
    pendingInteractions,
  );
  assert.deepEqual(await firstRuntime.shutdown(), { checkpoint: "completed" });

  const secondClient = await RuntimeIpcClient.connect(fixture.identity, { timeoutMs: 2_000 });
  context.after(() => secondClient.close().catch(() => undefined));
  assert.equal(secondClient.hostGenerationId, fixture.host.generationId);
  assertJsonEqual(await secondClient.request("session.list", { limit: 1 }), readResponse({ items: [] }));
  const secondRuntime = createRuntimeApplicationClient(secondClient);
  assertJsonEqual(
    await secondRuntime.runOperations.interactions({
      context: { authorization: LOCAL_AUTHORIZATION },
      sessionId: "session-1",
      runId: "run-1",
    }),
    pendingInteractions,
  );
});

test("runtime Application client preserves exact retry and export reconciliation after IPC response loss", async () => {
  const idempotencyKey = randomUUID();
  const destination = path.resolve("output.bin");
  const client = {
    async request(operation: RuntimeIpcOperation) {
      switch (operation) {
        case "run.start":
        case "session.archive":
          throw new RuntimeIpcClientError("connection_closed", "unknown", false);
        case "session.unarchive":
          throw new RuntimeIpcRemoteError({
            code: "request_rejected",
            message: "hidden remote detail",
            retryable: false,
            execution: "not_started",
          });
        case "session.list":
          throw new RuntimeIpcRemoteError({
            code: "runtime_unavailable",
            message: "hidden remote detail",
            retryable: true,
            execution: "not_started",
          });
        case "run.output_export":
          throw new RuntimeIpcClientError("request_timeout", "started", true);
        default:
          throw new Error(`Unexpected operation: ${operation}`);
      }
    },
    async close() {},
  } as unknown as RuntimeIpcClient;
  const runtime = createRuntimeApplicationClient(client);
  const context = { authorization: LOCAL_AUTHORIZATION };

  const start = await runtime.runOperations.start({
    context,
    sessionId: "session-1",
    idempotencyKey,
    contentBlocks: [{ type: "text", text: "hello" }],
    providerSettings: providerSettings(),
  });
  assert.deepEqual(start.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });

  const archive = await runtime.operations.archive({
    context,
    sessionId: "session-1",
    idempotencyKey,
  });
  assert.deepEqual(archive, {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: "persistence_unavailable",
      message: "Runtime host became unavailable.",
      retryable: false,
      effect: "unknown",
    },
    persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
  });
  const archiveCommand = {
    identity: { namespace: "session", operation: "archive" },
    sessionId: "session-1",
    idempotencyKey,
  } as const satisfies CliValidatedCommand;
  const archiveProjection = projectCliOperationOutput(archiveCommand, archive);
  assert.equal(archiveProjection.ok, true);
  if (!archiveProjection.ok) assert.fail("archive transport failure projection failed");
  assert.equal(archiveProjection.exitCode, CLI_EXIT_CODES.persistenceFailedUnknownEffect);
  assert.deepEqual(archiveProjection.output.applicationResponse.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });

  assert.deepEqual(await runtime.operations.unarchive({ context, sessionId: "session-1", idempotencyKey }), {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: "persistence_operation_failed",
      message: "Runtime operation failed.",
      retryable: false,
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  });
  assert.deepEqual(await runtime.operations.list({ context, limit: 1 }), {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: "persistence_unavailable",
      message: "Runtime host became unavailable.",
      retryable: true,
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  });

  const outputExport = await runtime.runOutputOperations.outputExport({
    context,
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    destinationGrant: {
      kind: "explicit_absolute_path",
      authority: "cli_user_selection",
      absolutePath: destination,
    },
  });
  assert.deepEqual(outputExport, {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: "persistence_timeout",
      message: "Runtime operation timed out.",
      retryable: true,
      effect: "none",
    },
    publication: { status: "unknown", reconciliation: "inspect_destination_before_retry" },
    persistence: { status: "failed", effect: "none" },
  });
  const exportCommand = {
    identity: { namespace: "run", operation: "output-export" },
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    destination,
  } as const satisfies CliValidatedRunCommand;
  const exportProjection = projectCliRunOperationOutput(exportCommand, outputExport);
  assert.equal(exportProjection.ok, true);
  if (!exportProjection.ok) assert.fail("output export transport failure projection failed");
  assert.equal(exportProjection.exitCode, CLI_EXIT_CODES.timeout);
  const exportApplicationResponse = exportProjection.output.applicationResponse;
  assert.ok("publication" in exportApplicationResponse);
  assert.deepEqual(exportApplicationResponse.publication, {
    status: "unknown",
    reconciliation: "inspect_destination_before_retry",
  });
});

test("runtime Application client owns the complete 27-operation proxy allowlist without forwarding authorization", async () => {
  const calls: Array<Readonly<{ operation: RuntimeIpcOperation; payload: RuntimeIpcOperationPayload }>> = [];
  let closeCalls = 0;
  const client = {
    async request(operation: RuntimeIpcOperation, payload: RuntimeIpcOperationPayload) {
      calls.push({ operation, payload });
      if (operation === "run.interactions") {
        return readResponse({ sessionId: "session-1", runId: "run-1", runVersion: 1, interactions: [] });
      }
      if (operation === "run.respond_interaction") {
        return writeResponse(respondInteractionValue());
      }
      return {};
    },
    async close() {
      closeCalls += 1;
    },
  } as unknown as RuntimeIpcClient;
  const runtime = createRuntimeApplicationClient(client);
  const context = { authorization: LOCAL_AUTHORIZATION };
  const idempotencyKey = randomUUID();

  await runtime.operations.create({
    context,
    title: "Title",
    workspacePath: path.resolve("."),
    idempotencyKey,
    providerId: "provider-1",
    allowedAdditionalDirectories: [],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 1,
  });
  await runtime.operations.updateTitle({ context, sessionId: "session-1", idempotencyKey, title: "Renamed" });
  await runtime.operations.list({ context, query: "query", limit: 1 });
  await runtime.operations.listLocalRepositories({ context, limit: 1 });
  await runtime.operations.read({ context, sessionId: "session-1" });
  await runtime.operations.readDirectoriesChunk({ context, sessionId: "session-1", offset: 0, maxBytes: 1 });
  await runtime.operations.archive({ context, sessionId: "session-1", idempotencyKey });
  await runtime.operations.unarchive({ context, sessionId: "session-1", idempotencyKey });
  await runtime.operations.close({
    context,
    sessionId: "session-1",
    idempotencyKey,
    expectedLifecycleStatus: "active",
  });
  await runtime.operations.delete({ context, sessionId: "session-1", idempotencyKey });
  await runtime.messageOperations.messages({ context, sessionId: "session-1", limit: 1 });
  await runtime.messageOperations.messageContentChunk({
    context,
    sessionId: "session-1",
    messageId: "message-1",
    offset: 0,
    maxBytes: 1,
  });
  await runtime.sessionRunOperations.runs({ context, sessionId: "session-1", limit: 1 });
  await runtime.runOperations.start({
    context,
    sessionId: "session-1",
    idempotencyKey,
    contentBlocks: [{ type: "text", text: "hello" }],
    providerSettings: providerSettings(),
  });
  await runtime.runOperations.retry({
    context,
    sessionId: "session-1",
    retryOfRunId: "run-source",
    idempotencyKey,
    providerSettingsOverride: providerSettings("high"),
  });
  await runtime.runOperations.sendInput({
    context,
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey,
    contentBlocks: [{ type: "text", text: "continue" }],
  });
  await runtime.runOperations.cancel({
    context,
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey,
  });
  await runtime.runOperations.respondInteraction({
    context,
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey,
    response: { interactionId: "interaction-1", kind: "provider.approval", payload: { decision: "accept" } },
  });
  await runtime.runOperations.status({ context, sessionId: "session-1", runId: "run-1" });
  await runtime.runOperations.interactions({ context, sessionId: "session-1", runId: "run-1" });
  await runtime.runOperations.events({ context, sessionId: "session-1", runId: "run-1", limit: 1 });
  await runtime.runOperations.follow({
    context,
    sessionId: "session-1",
    runId: "run-1",
    limit: 1,
    waitMs: 1,
    pollMs: 25,
  });
  await runtime.runOutputOperations.outputCounts({ context, sessionId: "session-1", runId: "run-1" });
  await runtime.runOutputOperations.outputs({ context, sessionId: "session-1", runId: "run-1", limit: 1 });
  await runtime.runOutputOperations.outputPreview({
    context,
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    maxBytes: 1,
  });
  await runtime.runOutputOperations.outputChunk({
    context,
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    offset: 0,
    maxBytes: 1,
  });
  await runtime.runOutputOperations.outputExport({
    context,
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    destinationGrant: {
      kind: "explicit_absolute_path",
      authority: "cli_user_selection",
      absolutePath: path.resolve("output.bin"),
    },
  });
  await runtime.shutdown();
  await runtime.shutdown();

  assert.deepEqual(
    calls.map(({ operation }) => operation),
    [...RUNTIME_IPC_OPERATIONS],
  );
  assert.equal(
    calls.some(({ payload }) => Object.hasOwn(payload, "context") || Object.hasOwn(payload, "authorization")),
    false,
  );
  assert.equal(calls[0]?.payload.idempotencyKey, idempotencyKey);
  assert.equal(calls.at(-1)?.payload.destination, path.resolve("output.bin"));
  assert.equal(closeCalls, 1);
});

test("runtime Application client canonicalizes valid interactions and rejects malformed projections from a hostile host", async () => {
  const canonicalValue = {
    sessionId: "session-1",
    runId: "run-1",
    runVersion: 7,
    interactions: canonicalInteractionSnapshots(),
  };
  const canonicalClient = {
    async request() {
      return readResponse(canonicalValue);
    },
    async close() {},
  } as unknown as RuntimeIpcClient;
  const canonicalRuntime = createRuntimeApplicationClient(canonicalClient);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await canonicalRuntime.runOperations.interactions({
          context: { authorization: LOCAL_AUTHORIZATION },
          sessionId: "session-1",
          runId: "run-1",
        }),
      ),
    ),
    readResponse(canonicalValue),
  );

  const validValue = {
    sessionId: "session-1",
    runId: "run-1",
    runVersion: 7,
    interactions: [interactionSnapshot("interaction-1")],
  };
  const invalidValues = [
    {
      ...validValue,
      interactions: [{ ...interactionSnapshot("interaction-1"), threadId: "private-thread" }],
    },
    {
      ...validValue,
      interactions: [interactionSnapshot("interaction-1"), interactionSnapshot("interaction-1")],
    },
    {
      ...validValue,
      interactions: [{ ...interactionSnapshot("interaction-1"), kind: "" }],
    },
    {
      ...validValue,
      interactions: [{ ...interactionSnapshot("interaction-1"), display: [] }],
    },
    {
      ...validValue,
      interactions: [
        {
          ...interactionSnapshot("interaction-1"),
          display: {
            summary: "Approve command",
            command: "node --version",
            rawRequestId: "provider-private",
          },
        },
      ],
    },
    {
      ...validValue,
      interactions: [
        {
          ...interactionSnapshot("interaction-1"),
          display: {
            summary: "Approve command",
            command: "node --version",
            absolutePath: "C:\\private\\secret.txt",
          },
        },
      ],
    },
    {
      ...validValue,
      interactions: [{ ...interactionSnapshot("interaction-1"), definitionVersion: "codex-unknown-v2" }],
    },
    {
      ...validValue,
      interactions: [
        {
          ...interactionSnapshot("interaction-1"),
          display: { summary: "path:C:\\Users\\alice\\secret.txt", command: "node --version" },
        },
      ],
    },
    {
      ...validValue,
      interactions: [
        {
          ...interactionSnapshot("interaction-1"),
          display: {
            summary: "Approve command",
            command: "node --version",
            availableDecisions: ["accept", "accept", "cancel"],
          },
        },
      ],
    },
  ];

  for (const invalidValue of invalidValues) {
    const client = {
      async request() {
        return readResponse(invalidValue);
      },
      async close() {},
    } as unknown as RuntimeIpcClient;
    const runtime = createRuntimeApplicationClient(client);
    await assert.rejects(
      runtime.runOperations.interactions({
        context: { authorization: LOCAL_AUTHORIZATION },
        sessionId: "session-1",
        runId: "run-1",
      }),
      /response is invalid|value is invalid/u,
    );
  }
});

test("runtime Application client rejects malformed interaction response certainty from a hostile host", async () => {
  const client = {
    async request() {
      return writeResponse({ ...respondInteractionValue(), semanticAction: "accept" });
    },
    async close() {},
  } as unknown as RuntimeIpcClient;
  const runtime = createRuntimeApplicationClient(client);
  await assert.rejects(
    runtime.runOperations.respondInteraction({
      context: { authorization: LOCAL_AUTHORIZATION },
      sessionId: "session-1",
      runId: "run-1",
      idempotencyKey: randomUUID(),
      response: { interactionId: "interaction-1", kind: "provider.approval", payload: { decision: "accept" } },
    }),
    /response is invalid|value is invalid/u,
  );
});

test("runtime Application client rejects partial interaction responses from a hostile host", async () => {
  const client = {
    async request() {
      return {
        overallStatus: "partial_success",
        value: respondInteractionValue(),
        issues: [
          {
            kind: "persistence",
            code: "persistence_operation_failed",
            message: "Persistence failed after interaction response admission.",
            retryable: true,
            effect: "unknown",
          },
        ],
        persistence: {
          status: "failed",
          effect: "unknown",
          reconciliation: "exact_request_required",
        },
      };
    },
    async close() {},
  } as unknown as RuntimeIpcClient;
  const runtime = createRuntimeApplicationClient(client);
  await assert.rejects(
    runtime.runOperations.respondInteraction({
      context: { authorization: LOCAL_AUTHORIZATION },
      sessionId: "session-1",
      runId: "run-1",
      idempotencyKey: randomUUID(),
      response: { interactionId: "interaction-1", kind: "provider.approval", payload: { decision: "accept" } },
    }),
    /response is invalid|value is invalid/u,
  );
});

test("simultaneous bootstrap attempts converge on one owner and do not spawn when a handshake is rejected", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-client-bootstrap-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const application = fakeRuntimeApplication({ list: async () => readResponse({ items: [] }) });
  let owner: RuntimeHost | undefined;
  let spawnCalls = 0;
  let initialConnects = 0;
  const initialConnectBarrier = deferred<void>();
  const dependencies: RuntimeHostBootstrapDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async connectClient(candidateIdentity, options) {
      if (initialConnects < 2) {
        initialConnects += 1;
        if (initialConnects === 2) initialConnectBarrier.resolve();
        await initialConnectBarrier.promise;
        throw new RuntimeEndpointUnavailableError("absent");
      }
      return await RuntimeIpcClient.connect(candidateIdentity, options);
    },
    async spawnHost() {
      spawnCalls += 1;
      try {
        const candidate = await startRuntimeHost({
          dependencies: hostDependencies(identity, application),
        });
        owner ??= candidate;
      } catch (error) {
        if (!(error instanceof RuntimeHostAlreadyRunningError)) throw error;
      }
    },
  };
  context.after(async () => {
    await owner?.close().catch(() => undefined);
  });

  const [first, second] = await Promise.all([
    startRuntimeHostClient({ dependencies, timeoutMs: 2_000 }),
    startRuntimeHostClient({ dependencies, timeoutMs: 2_000 }),
  ]);
  context.after(async () => {
    await first.shutdown().catch(() => undefined);
    await second.shutdown().catch(() => undefined);
  });
  assert.equal(spawnCalls, 2);
  assert.ok(owner !== undefined);
  assertJsonEqual(
    await first.operations.list({ context: { authorization: LOCAL_AUTHORIZATION }, limit: 1 }),
    readResponse({ items: [] }),
  );
  assertJsonEqual(
    await second.operations.list({ context: { authorization: LOCAL_AUTHORIZATION }, limit: 1 }),
    readResponse({ items: [] }),
  );

  let rejectedSpawnCalls = 0;
  const rejectedDependencies: RuntimeHostBootstrapDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async connectClient() {
      throw new RuntimeIpcClientError("handshake_rejected", "not_started", false);
    },
    async spawnHost() {
      rejectedSpawnCalls += 1;
    },
  };
  await assert.rejects(startRuntimeHostClient({ dependencies: rejectedDependencies, timeoutMs: 100 }));
  assert.equal(rejectedSpawnCalls, 0);
  await first.shutdown();
  await second.shutdown();
  await owner?.close();
});

test("runtime bootstrap is bounded when a spawned owner never becomes ready", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-client-timeout-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  let spawnCalls = 0;
  const dependencies: RuntimeHostBootstrapDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async connectClient() {
      throw new RuntimeEndpointUnavailableError("absent");
    },
    async spawnHost() {
      spawnCalls += 1;
    },
  };
  const startedAt = Date.now();
  await assert.rejects(startRuntimeHostClient({ dependencies, timeoutMs: 30 }));
  assert.equal(spawnCalls, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runtime bootstrap bounds owner identity resolution before any connect or spawn", async () => {
  let connectCalls = 0;
  let spawnCalls = 0;
  const dependencies: RuntimeHostBootstrapDependencies = {
    async resolveIdentity() {
      return await new Promise<RuntimeOwnerIdentity>(() => undefined);
    },
    async connectClient() {
      connectCalls += 1;
      throw new Error("Unexpected connect.");
    },
    async spawnHost() {
      spawnCalls += 1;
    },
  };

  await assert.rejects(
    startRuntimeHostClient({ dependencies, timeoutMs: 25 }),
    (error: unknown) => error instanceof RuntimeIpcClientError && error.code === "request_timeout",
  );
  assert.equal(connectCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("runtime bootstrap retries a readiness handshake timeout within the overall startup deadline", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-client-readiness-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  let connectCalls = 0;
  let spawnCalls = 0;
  let closeCalls = 0;
  const readyClient = {
    async request() {
      throw new Error("Unexpected operation.");
    },
    async close() {
      closeCalls += 1;
    },
  } as unknown as RuntimeIpcClient;
  const dependencies: RuntimeHostBootstrapDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async connectClient() {
      connectCalls += 1;
      if (connectCalls === 1) throw new RuntimeEndpointUnavailableError("absent");
      if (connectCalls === 2) throw new RuntimeIpcClientError("request_timeout", "not_started", true);
      return readyClient;
    },
    async spawnHost() {
      spawnCalls += 1;
    },
  };

  const runtime = await startRuntimeHostClient({ dependencies, timeoutMs: 500 });
  await runtime.shutdown();
  assert.equal(connectCalls, 3);
  assert.equal(spawnCalls, 1);
  assert.equal(closeCalls, 1);
});

test("a replacement host uses a new generation and an old client never crosses into it", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-client-generation-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const application = fakeRuntimeApplication({ list: async () => readResponse({ items: [] }) });
  const firstHost = await startRuntimeHost({ dependencies: hostDependencies(identity, application) });
  const oldClient = await RuntimeIpcClient.connect(identity, { timeoutMs: 2_000 });
  const oldGeneration = oldClient.hostGenerationId;
  await firstHost.close();
  await assert.rejects(oldClient.request("session.list", { limit: 1 }));

  const secondHost = await startRuntimeHost({ dependencies: hostDependencies(identity, application) });
  context.after(() => secondHost.close().catch(() => undefined));
  const newClient = await RuntimeIpcClient.connect(identity, { timeoutMs: 2_000 });
  context.after(() => newClient.close().catch(() => undefined));
  assert.notEqual(newClient.hostGenerationId, oldGeneration);
  assertJsonEqual(await newClient.request("session.list", { limit: 1 }), readResponse({ items: [] }));
});

type FakeMethod = (
  request: Readonly<Record<string, unknown>>,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

async function createHostFixture(
  context: test.TestContext,
  overrides: Readonly<Record<string, FakeMethod>>,
): Promise<Readonly<{ identity: RuntimeOwnerIdentity; host: RuntimeHost }>> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-client-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const host = await startRuntimeHost({
    dependencies: hostDependencies(identity, fakeRuntimeApplication(overrides)),
  });
  context.after(() => host.close().catch(() => undefined));
  return { identity, host };
}

function hostDependencies(
  identity: RuntimeOwnerIdentity,
  application: OwnedRuntimeApplication,
): RuntimeHostDependencies {
  return {
    async resolveIdentity() {
      return identity;
    },
    acquireClaim: acquireRuntimeOwnerClaim,
    createListener: createRuntimeEndpointListener,
    async startApplication() {
      return application;
    },
  };
}

function fakeRuntimeApplication(overrides: Readonly<Record<string, FakeMethod>>): OwnedRuntimeApplication {
  const fallback: FakeMethod = async () => {
    throw new Error("Unexpected Runtime Application operation.");
  };
  return {
    authorization: LOCAL_AUTHORIZATION,
    operations: {
      create: overrides.create ?? fallback,
      updateTitle: overrides.updateTitle ?? fallback,
      list: overrides.list ?? fallback,
      listLocalRepositories: overrides.listLocalRepositories ?? fallback,
      read: overrides.read ?? fallback,
      readDirectoriesChunk: overrides.readDirectoriesChunk ?? fallback,
      archive: overrides.archive ?? fallback,
      unarchive: overrides.unarchive ?? fallback,
      close: overrides.close ?? fallback,
      delete: overrides.delete ?? fallback,
    },
    messageOperations: {
      messages: overrides.messages ?? fallback,
      messageContentChunk: overrides.messageContentChunk ?? fallback,
    },
    sessionRunOperations: { runs: overrides.runs ?? fallback },
    runOperations: {
      start: overrides.start ?? fallback,
      retry: overrides.retry ?? fallback,
      sendInput: overrides.sendInput ?? fallback,
      cancel: overrides.cancel ?? fallback,
      respondInteraction: overrides.respondInteraction ?? fallback,
      status: overrides.status ?? fallback,
      interactions: overrides.interactions ?? fallback,
      events: overrides.events ?? fallback,
      follow: overrides.follow ?? fallback,
    },
    runOutputOperations: {
      outputCounts: overrides.outputCounts ?? fallback,
      outputs: overrides.outputs ?? fallback,
      outputPreview: overrides.outputPreview ?? fallback,
      outputChunk: overrides.outputChunk ?? fallback,
      outputExport: overrides.outputExport ?? fallback,
    },
    fatalError: new Promise(() => undefined),
    async shutdown() {
      return { checkpoint: "completed" };
    },
  } as unknown as OwnedRuntimeApplication;
}

function readResponse(value: unknown): Readonly<Record<string, unknown>> {
  return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } };
}

function writeResponse(value: unknown): Readonly<Record<string, unknown>> {
  return {
    overallStatus: "success",
    value,
    persistence: { status: "committed", effect: "none", replayed: false },
  };
}

function runStatus(runId: string): Readonly<Record<string, unknown>> {
  return {
    sessionId: "session-1",
    runId,
    phase: "active",
    liveActivity: "running",
    createdAt: 1,
    updatedAt: 1,
  };
}

function interactionSnapshot(interactionId: string): Readonly<Record<string, unknown>> {
  return {
    interactionId,
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    kind: "codex.command_approval",
    answerable: true,
    display: {
      summary: "Approve command",
      command: "node --version",
      availableDecisions: ["accept", "decline", "cancel"],
    },
  };
}

function canonicalInteractionSnapshots() {
  const base = {
    providerId: "codex",
    definitionVersion: "codex-provider-v1",
    answerable: true,
  } as const;
  return [
    {
      ...base,
      interactionId: "interaction-command",
      kind: "codex.command_approval",
      display: {
        summary: "Approve command",
        command: "node --version",
        availableDecisions: ["accept", "decline", "cancel"],
      },
    },
    {
      ...base,
      interactionId: "interaction-file",
      kind: "codex.file_change_approval",
      display: { summary: "Changes", changes: [{ displayPath: "src/index.ts", changeKind: "update" }] },
    },
    {
      ...base,
      interactionId: "interaction-permission",
      kind: "codex.permission_approval",
      display: { summary: "Permissions", permissions: ["workspace_write"] },
    },
    {
      ...base,
      interactionId: "interaction-input",
      kind: "codex.user_input",
      display: {
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            prompt: "Choose one",
            allowOther: false,
            options: [{ label: "one" }, { label: "two", description: "Second" }],
          },
        ],
      },
    },
    {
      ...base,
      interactionId: "interaction-tool",
      kind: "codex.mcp_tool_approval",
      display: { server: "fixture", tool: "collect", summary: "Allow collect" },
    },
    {
      ...base,
      interactionId: "interaction-form",
      kind: "codex.mcp_server_form",
      display: {
        server: "fixture",
        message: "Enter values",
        fields: [{ fieldId: "value", label: "Value", inputType: "string", required: false, maxLength: 4096 }],
      },
    },
    {
      ...base,
      interactionId: "interaction-unavailable",
      kind: "codex.command_approval",
      answerable: false,
      display: {
        summary: "A command approval request is unavailable.",
        unavailableReason: "unsafe_projection",
      },
    },
  ] as const;
}

function respondInteractionValue(): Readonly<Record<string, unknown>> {
  return {
    sessionId: "session-1",
    runId: "run-1",
    interactionId: "interaction-1",
    admittedAt: 1,
    effectCertainty: "admitted",
    writeAttemptedAt: null,
    settledAt: null,
    resolutionCode: null,
  };
}

function valueRunId(value: unknown): unknown {
  return (value as Readonly<{ value: Readonly<{ runId: unknown }> }>).value.runId;
}

function assertJsonEqual(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function deferred<TValue>(): Readonly<{
  promise: Promise<TValue>;
  resolve(value: TValue): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: TValue) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queuedWriteTransport(): Readonly<{
  connection: RuntimeEndpointConnection;
  envelopes: RuntimeIpcEnvelope[];
  disconnect(): void;
}> {
  const envelopes: RuntimeIpcEnvelope[] = [];
  const queuedReads: Array<Uint8Array | null> = [];
  const readWaiters: Array<{
    resolve(value: Uint8Array | null): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  const requestWrite = deferred<void>();
  let closed = false;

  const offerRead = (value: Uint8Array | null) => {
    const waiter = readWaiters.shift();
    if (waiter === undefined) {
      queuedReads.push(value);
      return;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
    waiter.resolve(value);
  };
  const disconnect = () => {
    if (closed) return;
    closed = true;
    requestWrite.resolve();
    offerRead(null);
  };
  const connection: RuntimeEndpointConnection = {
    peerPrincipalId: "test-principal",
    endpointSecurity: { daclSddl: "" },
    async write(bytes) {
      const envelope = decodeRuntimeIpcEnvelope(JSON.parse(Buffer.from(bytes).toString("utf8")));
      envelopes.push(envelope);
      if (envelope.kind === "handshake_request") {
        offerRead(
          Buffer.from(
            encodeRuntimeIpcEnvelope({
              protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
              kind: "handshake_response",
              clientId: envelope.clientId,
              hostGenerationId: randomUUID(),
            }),
          ),
        );
        return;
      }
      await requestWrite.promise;
    },
    async read(signal) {
      const queued = queuedReads.shift();
      if (queued !== undefined || queuedReads.length > 0) return queued ?? null;
      if (closed) return null;
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return await new Promise<Uint8Array | null>((resolve, reject) => {
        const waiter: (typeof readWaiters)[number] = {
          resolve,
          reject,
          ...(signal === undefined ? {} : { signal }),
        };
        readWaiters.push(waiter);
        if (signal !== undefined) {
          waiter.onAbort = () => {
            const index = readWaiters.indexOf(waiter);
            if (index !== -1) readWaiters.splice(index, 1);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
          if (signal.aborted) waiter.onAbort();
        }
      });
    },
    async close() {
      disconnect();
    },
  };
  return { connection, envelopes, disconnect };
}

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise((_resolve, reject) => {
    const onAbort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime client state.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
