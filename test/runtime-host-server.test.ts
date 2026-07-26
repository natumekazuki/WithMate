import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Worker } from "node:worker_threads";

import {
  RUNTIME_IPC_LIMITS,
  RUNTIME_IPC_OPERATIONS,
  RUNTIME_IPC_PROTOCOL_VERSION,
  decodeRuntimeIpcEnvelope,
  deriveRuntimeRequestId,
  encodeRuntimeIpcEnvelope,
  type RuntimeIpcEnvelope,
  type RuntimeIpcOperation,
  type RuntimeIpcOperationPayload,
  type RuntimeIpcRequest,
  type RuntimeIpcResponse,
} from "../src/main/runtime-host/runtime-ipc-contract.js";
import { RuntimeIpcJsonlDecoder } from "../src/main/runtime-host/runtime-ipc-jsonl.js";
import { decodeRuntimeWireValue } from "../src/main/runtime-host/runtime-ipc-value.js";
import { snapshotRuntimeApplicationResponse } from "../src/main/runtime-host/runtime-application-response.js";
import { startRuntimeHost, type RuntimeHostDependencies } from "../src/main/runtime-host/runtime-host.js";
import { dispatchRuntimeApplicationOperation } from "../src/main/runtime-host/runtime-application-dispatch.js";
import { PersistenceClientError, PersistenceWorkerClient } from "../src/main/persistence-worker-client.js";
import type { OwnedRuntimeApplication, RuntimeApplication } from "../src/main/runtime-application.js";
import { PERSISTENCE_PROTOCOL_VERSION } from "../src/shared/persistence-protocol.js";
import {
  connectRuntimeEndpoint,
  createRuntimeEndpointListener,
  type RuntimeEndpointConnection,
  type RuntimeEndpointListener,
} from "../src/main/runtime-host/runtime-endpoint.js";
import { acquireRuntimeOwnerClaim, type RuntimeOwnerClaim } from "../src/main/runtime-host/runtime-owner-claim.js";
import {
  resolveRuntimeOwnerIdentity,
  type RuntimeOwnerIdentity,
} from "../src/main/runtime-host/runtime-owner-identity.js";

const LOCAL_AUTHORIZATION = Object.freeze({
  transport: "local_cli",
  principal: "current_os_user",
} as const);

test("runtime host establishes endpoint ownership before Application startup and shuts down in owner order", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-order-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const events: string[] = [];
  const claim = fakeClaim(identity, events);
  const listener = blockingListener(events);
  const application = fakeRuntimeApplication({}, () => {
    events.push("application.shutdown");
    return Promise.resolve({ checkpoint: "completed" });
  });
  const dependencies: RuntimeHostDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async acquireClaim() {
      events.push("claim");
      return claim;
    },
    async createListener() {
      events.push("listen");
      return listener;
    },
    async startApplication() {
      events.push("application");
      return application;
    },
  };

  const host = await startRuntimeHost({ dependencies });
  const result = await host.close();

  assert.deepEqual(result, { checkpoint: "completed" });
  assert.deepEqual(events, [
    "claim",
    "listen",
    "application",
    "application.shutdown",
    "listener.close",
    "claim.release",
  ]);
});

test(
  "Windows runtime host survives a readiness client disconnect before Application startup completes",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-readiness-disconnect-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    const application = fakeRuntimeApplication();
    let signalApplicationStarting!: () => void;
    let releaseApplication!: () => void;
    const applicationStarting = new Promise<void>((resolve) => {
      signalApplicationStarting = resolve;
    });
    const applicationGate = new Promise<void>((resolve) => {
      releaseApplication = resolve;
    });
    const dependencies: RuntimeHostDependencies = {
      resolveIdentity: resolveRuntimeOwnerIdentity,
      acquireClaim: acquireRuntimeOwnerClaim,
      createListener: createRuntimeEndpointListener,
      async startApplication() {
        signalApplicationStarting();
        await applicationGate;
        return application;
      },
    };
    const startingHost = startRuntimeHost({ applicationDataRoot: fixtureRoot, dependencies });
    await applicationStarting;

    const readinessConnection = await connectRuntimeEndpoint(identity, { timeoutMs: 2_000 });
    await readinessConnection.close();
    releaseApplication();

    const host = await startingHost;
    await new Promise((resolve) => setImmediate(resolve));
    let connection: RuntimeEndpointConnection | undefined;
    context.after(async () => {
      await connection?.close().catch(() => undefined);
      await host.close().catch(() => undefined);
    });
    connection = await connectRuntimeEndpoint(identity, { timeoutMs: 2_000 });
    const client = new TestRuntimeClient(connection, host.generationId);
    await client.handshake();

    const state = await Promise.race([
      host.closed.then(() => "closed" as const),
      new Promise<"open">((resolve) => setImmediate(() => resolve("open"))),
    ]);
    assert.equal(state, "open");
  },
);

test("runtime host rejects invalid startup deadlines before acquiring owned resources", async () => {
  let dependencyCalls = 0;
  const unavailable = async (): Promise<never> => {
    dependencyCalls += 1;
    throw new Error("A startup dependency must not run.");
  };
  const dependencies = {
    resolveIdentity: unavailable,
    acquireClaim: unavailable,
    createListener: unavailable,
    startApplication: unavailable,
  } as unknown as RuntimeHostDependencies;

  await assert.rejects(() => startRuntimeHost({ dependencies, handshakeTimeoutMs: 0 }), /timeout is invalid/u);
  await assert.rejects(() => startRuntimeHost({ dependencies, partialLineTimeoutMs: 0 }), /timeout is invalid/u);
  await assert.rejects(() => startRuntimeHost({ dependencies, timeoutMs: 0 }), /timeout is invalid/u);
  assert.equal(dependencyCalls, 0);
});

for (const failureMode of ["timeout", "abort", "startup_failure", "crash"] as const) {
  const failureLabel = {
    timeout: "timed-out",
    abort: "canceled",
    startup_failure: "startup-failed",
    crash: "crashed",
  }[failureMode];
  test(`runtime host startup retains ownership until a ${failureLabel} Persistence Worker exits`, async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), `withmate-runtime-host-startup-worker-${failureMode}-`));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    const worker = new DelayedTerminationWorker();
    context.after(() => worker.finish());
    let workerCreated = false;
    const client = new PersistenceWorkerClient({
      createWorker: () => {
        workerCreated = true;
        return worker as unknown as Worker;
      },
      databasePath: identity.databasePath,
      legacyDatabasePaths: [],
      startupTimeoutMs: failureMode === "timeout" ? 25 : 10_000,
    });
    const controller = new AbortController();
    const dependencies: RuntimeHostDependencies = {
      async resolveIdentity() {
        return identity;
      },
      acquireClaim: acquireRuntimeOwnerClaim,
      createListener: createRuntimeEndpointListener,
      async startApplication(_identity, control) {
        await client.start(control?.signal === undefined ? {} : { signal: control.signal });
        throw new Error("The delayed test Worker must not become ready.");
      },
    };
    const startup = startRuntimeHost({
      dependencies,
      ...(failureMode === "abort" ? { signal: controller.signal } : {}),
    });
    let startupSettled = false;
    void startup.then(
      () => {
        startupSettled = true;
      },
      () => {
        startupSettled = true;
      },
    );
    if (failureMode !== "timeout") {
      await waitFor(() => workerCreated);
      if (failureMode === "abort") {
        controller.abort();
      } else if (failureMode === "startup_failure") {
        worker.emit("message", {
          protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
          generationId: client.generationId,
          kind: "startupFailed",
          error: {
            code: "worker_start_failed",
            message: "Persistence fixture startup failed.",
            retryable: false,
            effect: "none",
          },
        });
      } else {
        worker.emit("error", new Error("Persistence fixture crashed."));
      }
    }
    await waitFor(() => worker.terminateCalls === 1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(startupSettled, false);
    const overlappingClaim = await acquireRuntimeOwnerClaim(identity);
    if (overlappingClaim.status === "acquired") await overlappingClaim.release();
    assert.equal(overlappingClaim.status, "busy");

    worker.finish();
    const expectedFailure = {
      timeout: /startup timed out/u,
      abort: /startup was canceled/u,
      startup_failure: /fixture startup failed/u,
      crash: /worker crashed/u,
    }[failureMode];
    await assert.rejects(startup, expectedFailure);
    const replacementClaim = await acquireRuntimeOwnerClaimEventually(identity);
    await replacementClaim.release();
  });
}

test("ready Persistence Worker publishes its fatal lifecycle only after the Worker exits", async (context) => {
  const worker = new DelayedTerminationWorker();
  context.after(() => worker.finish());
  const client = new PersistenceWorkerClient({
    createWorker: () => worker as unknown as Worker,
    databasePath: path.resolve("unused-runtime-host-fatal.sqlite3"),
    legacyDatabasePaths: [],
  });
  const startup = client.start();
  worker.emit("message", {
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId: client.generationId,
    kind: "ready",
  });
  await startup;
  let fatalSettled = false;
  void client.fatalError.then(() => {
    fatalSettled = true;
  });

  worker.emit("error", new Error("Persistence fixture crashed after readiness."));
  const shutdownSettlement = client.shutdown().then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  let shutdownSettled = false;
  void shutdownSettlement.then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.state, "failed");
  assert.equal(fatalSettled, false);
  assert.equal(shutdownSettled, false);

  worker.finish();
  const fatalError = await client.fatalError;
  assert.ok(fatalError instanceof PersistenceClientError);
  assert.equal(fatalError.persistenceError.code, "worker_crashed");
  const shutdownResult = await shutdownSettlement;
  assert.equal(shutdownResult.status, "rejected");
  if (shutdownResult.status === "rejected") {
    assert.ok(shutdownResult.error instanceof PersistenceClientError);
    assert.equal(shutdownResult.error.persistenceError.code, "worker_not_ready");
  }
});

test("runtime host releases canonical ownership after a ready Application fatal lifecycle", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-ready-worker-fatal-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  let publishFatal!: (error: Error) => void;
  const fatalError = new Promise<Error>((resolve) => {
    publishFatal = resolve;
  });
  let shutdownCalls = 0;
  const application = fakeRuntimeApplication(
    {},
    async () => {
      shutdownCalls += 1;
      throw new Error("Persistence Worker is no longer ready.");
    },
    fatalError,
  );
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(application),
  });
  context.after(() => host.close().catch(() => undefined));
  const overlappingClaim = await acquireRuntimeOwnerClaim(identity);
  if (overlappingClaim.status === "acquired") await overlappingClaim.release();
  assert.equal(overlappingClaim.status, "busy");

  publishFatal(new Error("Persistence Worker exited."));

  await assert.rejects(host.closed, /Runtime host shutdown was incomplete/u);
  assert.equal(shutdownCalls, 1);
  const replacementClaim = await acquireRuntimeOwnerClaimEventually(identity);
  await replacementClaim.release();
});

test("runtime host dispatches read, write, chunk, follow, and export families with host authorization", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-families-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const captures: Array<Readonly<{ method: string; request: Readonly<Record<string, unknown>> }>> = [];
  const application = fakeRuntimeApplication(
    {
      updateTitle: capture("updateTitle", writeResponse({ sessionId: "session-1", title: "Renamed", updatedAt: 2 })),
      list: capture("list", readResponse({ items: [] })),
      readDirectoriesChunk: capture(
        "readDirectoriesChunk",
        readResponse({
          sessionId: "session-1",
          offset: 0,
          totalBytes: 3,
          eof: true,
          bytes: Uint8Array.from([1, 2, 3]).buffer,
        }),
      ),
      follow: capture(
        "follow",
        readResponse({
          reason: "deadline",
          status: {
            sessionId: "session-1",
            runId: "run-1",
            phase: "active",
            liveActivity: "running",
            createdAt: 1,
            updatedAt: 2,
          },
          events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "cursor-1" },
        }),
      ),
      outputExport: capture("outputExport", {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          runId: "run-1",
          outputItemId: "output-1",
          format: "binary",
          storedByteLength: 3,
          contentSha256: "a".repeat(64),
        },
        publication: { status: "published" },
        persistence: { status: "read", effect: "none" },
      }),
    },
    () => Promise.resolve({ checkpoint: "completed" }),
  );
  const dependencies = realEndpointDependencies(application);
  const host = await startRuntimeHost({ applicationDataRoot: fixtureRoot, dependencies });
  const connection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  context.after(async () => {
    await connection.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  });
  const client = new TestRuntimeClient(connection, host.generationId);
  await client.handshake();

  const cases: ReadonlyArray<readonly [RuntimeIpcOperation, RuntimeIpcOperationPayload]> = [
    ["session.update_title", { sessionId: "session-1", idempotencyKey: randomUUID(), title: "Renamed" }],
    ["session.list", { limit: 1 }],
    ["session.read_directories_chunk", { sessionId: "session-1", offset: 0, maxBytes: 3 }],
    ["run.follow", { sessionId: "session-1", runId: "run-1", cursor: "cursor-1", limit: 1, waitMs: 1, pollMs: 25 }],
    [
      "run.output_export",
      {
        sessionId: "session-1",
        runId: "run-1",
        outputItemId: "output-1",
        destination: path.join(fixtureRoot, "export.bin"),
      },
    ],
  ];
  const results: unknown[] = [];
  for (const [operation, payload] of cases) {
    const response = await client.request(operation, payload);
    assert.equal(response.outcome, "success");
    if (response.outcome === "success") results.push(decodeRuntimeWireValue(response.value));
  }

  assert.deepEqual(
    captures.map(({ method }) => method),
    ["updateTitle", "list", "readDirectoriesChunk", "follow", "outputExport"],
  );
  for (const { request } of captures) {
    assert.deepEqual(request.context, { authorization: LOCAL_AUTHORIZATION });
    assert.equal(Object.hasOwn(request, "authorization"), false);
  }
  assert.deepEqual(
    new Uint8Array(
      (
        results[2] as Readonly<{
          value: Readonly<{ bytes: ArrayBuffer }>;
        }>
      ).value.bytes,
    ),
    Uint8Array.from([1, 2, 3]),
  );
  assert.deepEqual(captures[4]?.request.destinationGrant, {
    kind: "explicit_absolute_path",
    authority: "cli_user_selection",
    absolutePath: path.join(fixtureRoot, "export.bin"),
  });

  function capture(method: string, response: unknown) {
    return async (request: Readonly<Record<string, unknown>>) => {
      captures.push({ method, request });
      return response;
    };
  }
});

test("runtime host rejects operation before handshake and reports version mismatch before dispatch", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-handshake-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  let dispatchCount = 0;
  const application = fakeRuntimeApplication({
    list: async () => {
      dispatchCount += 1;
      return readResponse({ items: [] });
    },
  });
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(application),
  });
  context.after(() => host.close().catch(() => undefined));

  const premature = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  const clientId = randomUUID();
  await premature.write(
    Buffer.from(encodeRuntimeIpcEnvelope(runtimeRequest(host.generationId, clientId, 1, "session.list", { limit: 1 }))),
  );
  assert.equal(await premature.read(), null);
  assert.equal(dispatchCount, 0);

  const mismatch = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  await mismatch.write(
    Buffer.from(
      `${JSON.stringify({
        protocolVersion: "withmate-runtime-ipc-v2",
        kind: "handshake_request",
        clientId,
      })}\n`,
    ),
  );
  const rejection = await readEnvelope(mismatch);
  assert.equal(rejection.kind, "handshake_rejection");
  if (rejection.kind === "handshake_rejection") assert.equal(rejection.error.code, "version_mismatch");
  assert.equal(await mismatch.read(), null);
  assert.equal(dispatchCount, 0);
});

test("runtime host keeps a second client responsive while the first client waits in follow", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-concurrency-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  let releaseFollow: (() => void) | undefined;
  const followGate = new Promise<void>((resolve) => {
    releaseFollow = resolve;
  });
  const application = fakeRuntimeApplication({
    follow: async () => {
      await followGate;
      return readResponse({
        reason: "deadline",
        status: {
          sessionId: "session-1",
          runId: "run-1",
          phase: "active",
          liveActivity: null,
          createdAt: 1,
          updatedAt: 1,
        },
        events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "cursor-1" },
      });
    },
    list: async () => readResponse({ items: [] }),
  });
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(application),
  });
  context.after(() => host.close().catch(() => undefined));
  const firstConnection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  const secondConnection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  context.after(async () => {
    await Promise.allSettled([firstConnection.close(), secondConnection.close()]);
  });
  const first = new TestRuntimeClient(firstConnection, host.generationId);
  const second = new TestRuntimeClient(secondConnection, host.generationId);
  await Promise.all([first.handshake(), second.handshake()]);

  const pendingFollow = first.request("run.follow", {
    sessionId: "session-1",
    runId: "run-1",
    cursor: "cursor-1",
    limit: 1,
    waitMs: 1,
    pollMs: 25,
  });
  const read = await second.request("session.list", { limit: 1 });
  assert.equal(read.outcome, "success");
  releaseFollow?.();
  assert.equal((await pendingFollow).outcome, "success");
});

test("runtime host bounds in-flight work per connection and aborts abandoned reads", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-cap-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  let abortedReads = 0;
  const application = fakeRuntimeApplication({
    list: async (_request, options) =>
      await new Promise((_resolve, reject) => {
        const onAbort = () => {
          abortedReads += 1;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });
      }),
  });
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(application),
  });
  const connection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  context.after(async () => {
    await connection.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  });
  const clientId = randomUUID();
  await connection.write(
    Buffer.from(
      encodeRuntimeIpcEnvelope({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "handshake_request",
        clientId,
      }),
    ),
  );
  await readEnvelope(connection);
  for (let sequence = 1; sequence <= 33; sequence += 1) {
    await connection.write(
      Buffer.from(
        encodeRuntimeIpcEnvelope(runtimeRequest(host.generationId, clientId, sequence, "session.list", { limit: 1 })),
      ),
    );
  }
  const response = await readEnvelope(connection);
  assert.equal(response.kind, "response");
  if (response.kind === "response") {
    assert.equal(response.requestSequence, 33);
    assert.equal(response.outcome, "failure");
    if (response.outcome === "failure") assert.equal(response.error.code, "resource_exhausted");
  }
  await connection.close();
  await waitFor(() => abortedReads === 32);
});

test("runtime host propagates client cancel to export but not disconnect to durable writes", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-cancel-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  let exportSignal: AbortSignal | undefined;
  let writeSignal: AbortSignal | undefined;
  let completeWrite: ((value: unknown) => void) | undefined;
  const application = fakeRuntimeApplication({
    outputExport: async (_request, options) => {
      exportSignal = options?.signal;
      return await rejectWhenAborted(options?.signal);
    },
    updateTitle: async (_request, options) => {
      writeSignal = options?.signal;
      return await new Promise((resolve) => {
        completeWrite = resolve;
      });
    },
  });
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(application),
  });
  context.after(() => host.close().catch(() => undefined));

  const exportConnection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  const exportClientId = randomUUID();
  await exportConnection.write(
    Buffer.from(
      encodeRuntimeIpcEnvelope({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "handshake_request",
        clientId: exportClientId,
      }),
    ),
  );
  await readEnvelope(exportConnection);
  const exportRequest = runtimeRequest(host.generationId, exportClientId, 1, "run.output_export", {
    sessionId: "session-1",
    runId: "run-1",
    outputItemId: "output-1",
    destination: path.join(fixtureRoot, "export.bin"),
  });
  await exportConnection.write(Buffer.from(encodeRuntimeIpcEnvelope(exportRequest)));
  await waitFor(() => exportSignal !== undefined);
  await exportConnection.write(
    Buffer.from(
      encodeRuntimeIpcEnvelope({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "cancel",
        hostGenerationId: host.generationId,
        clientId: exportClientId,
        requestId: exportRequest.requestId,
        requestSequence: exportRequest.requestSequence,
      }),
    ),
  );
  await waitFor(() => exportSignal?.aborted === true);
  await exportConnection.close();

  const writeConnection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  const writeClientId = randomUUID();
  await writeConnection.write(
    Buffer.from(
      encodeRuntimeIpcEnvelope({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "handshake_request",
        clientId: writeClientId,
      }),
    ),
  );
  await readEnvelope(writeConnection);
  await writeConnection.write(
    Buffer.from(
      encodeRuntimeIpcEnvelope(
        runtimeRequest(host.generationId, writeClientId, 1, "session.update_title", {
          sessionId: "session-1",
          idempotencyKey: randomUUID(),
          title: "Renamed",
        }),
      ),
    ),
  );
  await waitFor(() => writeSignal !== undefined);
  await writeConnection.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeSignal?.aborted, false);
  completeWrite?.(writeResponse({ sessionId: "session-1", title: "Renamed", updatedAt: 2 }));
  await host.close();
});

test("runtime host shutdown deadline retains ownership until the durable request and cleanup settle", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-shutdown-deadline-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  let writeStarted = false;
  let completeWrite: ((value: unknown) => void) | undefined;
  let shutdownCalls = 0;
  const application = fakeRuntimeApplication(
    {
      updateTitle: async () => {
        writeStarted = true;
        return await new Promise<unknown>((resolve) => {
          completeWrite = resolve;
        });
      },
    },
    async () => {
      shutdownCalls += 1;
      return { checkpoint: "completed" };
    },
  );
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(application),
  });
  const connection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  context.after(() => connection.close().catch(() => undefined));
  const client = new TestRuntimeClient(connection, host.generationId);
  await client.handshake();
  const pending = client
    .request("session.update_title", {
      sessionId: "session-1",
      idempotencyKey: randomUUID(),
      title: "Renamed",
    })
    .catch(() => undefined);
  await waitFor(() => writeStarted);

  await assert.rejects(() => host.close({ timeoutMs: 50 }), /shutdown was incomplete/u);
  assert.equal(shutdownCalls, 0);
  const overlappingClaim = await acquireRuntimeOwnerClaim(host.identity);
  assert.equal(overlappingClaim.status, "busy");

  completeWrite?.(writeResponse({ sessionId: "session-1", title: "Renamed", updatedAt: 2 }));
  await pending;
  assert.deepEqual(await host.closed, { checkpoint: "completed" });
  assert.deepEqual(await host.close({ timeoutMs: 2_000 }), { checkpoint: "completed" });
  assert.equal(shutdownCalls, 1);
  const replacementClaim = await acquireRuntimeOwnerClaimEventually(host.identity);
  await replacementClaim.release();
});

test("runtime host shutdown aborts stalled response delivery after the durable operation settles", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-slow-response-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const events: string[] = [];
  const claim = fakeClaim(identity, events);
  const connection = new ScriptedRuntimeConnection(identity.principalId);
  const listener = singleConnectionListener(connection);
  const application = fakeRuntimeApplication(
    {
      updateTitle: async () => writeResponse({ sessionId: "session-1", title: "Renamed", updatedAt: 2 }),
    },
    async () => {
      events.push("application.shutdown");
      return { checkpoint: "completed" };
    },
  );
  const dependencies: RuntimeHostDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async acquireClaim() {
      return claim;
    },
    async createListener() {
      return listener;
    },
    async startApplication() {
      return application;
    },
  };
  const host = await startRuntimeHost({ dependencies });
  const clientId = randomUUID();
  connection.enqueue(
    Buffer.from(
      [
        encodeRuntimeIpcEnvelope({
          protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
          kind: "handshake_request",
          clientId,
        }),
        encodeRuntimeIpcEnvelope(
          runtimeRequest(host.generationId, clientId, 1, "session.update_title", {
            sessionId: "session-1",
            idempotencyKey: randomUUID(),
            title: "Renamed",
          }),
        ),
      ].join(""),
    ),
  );
  await waitFor(() => connection.writes === 2);

  assert.deepEqual(await host.close({ timeoutMs: 2_000 }), { checkpoint: "completed" });
  assert.deepEqual(events, ["application.shutdown", "claim.release"]);
  assert.equal(connection.closed, true);
});

test("runtime response budget exhaustion closes the transport before a later durable request is dispatched", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-response-budget-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
  const events: string[] = [];
  const claim = fakeClaim(identity, events);
  const connection = new ScriptedRuntimeConnection(identity.principalId);
  const listener = singleConnectionListener(connection);
  let durableDispatches = 0;
  const largeItems = Array.from({ length: 10 }, (_unused, index) => ({
    id: `session-${index}`,
    title: "Title",
    workspacePath: path.resolve(`runtime-budget-${"x".repeat(30_000)}-${index}`),
    localRepositoryKey: null,
    repositoryName: null,
    defaultCharacterId: "character-1",
    lifecycleStatus: "active",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    stateChangedAt: 1,
    executionState: "not_started",
  }));
  const application = fakeRuntimeApplication({
    list: async () => readResponse({ items: largeItems }),
    updateTitle: async () => {
      durableDispatches += 1;
      return writeResponse({ sessionId: "session-1", title: "Renamed", updatedAt: 2 });
    },
  });
  const dependencies: RuntimeHostDependencies = {
    async resolveIdentity() {
      return identity;
    },
    async acquireClaim() {
      return claim;
    },
    async createListener() {
      return listener;
    },
    async startApplication() {
      return application;
    },
  };
  const host = await startRuntimeHost({ dependencies });
  context.after(() => host.close().catch(() => undefined));
  const clientId = randomUUID();
  const envelopes: RuntimeIpcEnvelope[] = [
    {
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "handshake_request",
      clientId,
    },
  ];
  for (let sequence = 1; sequence <= RUNTIME_IPC_LIMITS.maxInFlightPerConnection + 1; sequence += 1) {
    envelopes.push(runtimeRequest(host.generationId, clientId, sequence, "session.list", { limit: 100 }));
  }
  envelopes.push(
    runtimeRequest(
      host.generationId,
      clientId,
      RUNTIME_IPC_LIMITS.maxInFlightPerConnection + 2,
      "session.update_title",
      { sessionId: "session-1", idempotencyKey: randomUUID(), title: "Renamed" },
    ),
  );
  connection.enqueue(Buffer.from(envelopes.map(encodeRuntimeIpcEnvelope).join("")));

  await waitFor(() => connection.closed);
  assert.equal(durableDispatches, 0);
  await host.close();
});

test("runtime response projection rejects fields outside the operation-owned Application shape", () => {
  assert.doesNotThrow(() =>
    snapshotRuntimeApplicationResponse(
      "session.read_directories_chunk",
      { sessionId: "session-1", offset: 0, maxBytes: 2 },
      readResponse({
        sessionId: "session-1",
        offset: 0,
        totalBytes: 3,
        eof: false,
        bytes: Uint8Array.from([1, 2]).buffer,
      }),
    ),
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.list",
        { limit: 1 },
        {
          ...readResponse({ items: [] }),
          worker: { databasePath: "private" },
        },
      ),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.messages",
        { sessionId: "session-1", limit: 1 },
        readResponse({
          sessionId: "session-1",
          items: [
            {
              id: "message-1",
              ordinal: 1,
              role: "user",
              contentByteLength: 33,
              content: { state: "inline", blocks: [{ type: 7, text: { private: "leak" } }] },
              createdAt: 1,
            },
          ],
        }),
      ),
    /response is invalid/u,
  );
  assert.throws(
    () => snapshotRuntimeApplicationResponse("session.list", { limit: 1 }, readResponse({ items: [], nextCursor: 7 })),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.create",
        {
          title: "Title",
          workspacePath: path.resolve("."),
          idempotencyKey: randomUUID(),
          providerId: "provider-1",
          allowedAdditionalDirectories: [],
          defaultCharacterId: "character-1",
          maxConcurrentChildRuns: 1,
        },
        writeResponse({
          sessionId: 7,
          title: "Title",
          workspacePath: path.resolve("."),
          localRepositoryKey: null,
          repositoryName: null,
          lifecycleStatus: "active",
          createdAt: 1,
        }),
      ),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.read_directories_chunk",
        { sessionId: "session-1", offset: 0, maxBytes: 3 },
        readResponse({
          sessionId: "session-other",
          offset: 0,
          totalBytes: 3,
          eof: true,
          bytes: Uint8Array.from([1, 2, 3]).buffer,
        }),
      ),
    /response is invalid/u,
  );
  assert.throws(() => {
    const response = readResponse({ items: [] });
    Object.defineProperty(response, "authorization", {
      enumerable: true,
      get() {
        return LOCAL_AUTHORIZATION;
      },
    });
    snapshotRuntimeApplicationResponse("session.list", { limit: 1 }, response);
  }, /response is invalid/u);
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.read_directories_chunk",
        { sessionId: "session-1", offset: 0, maxBytes: 3 },
        readResponse({
          sessionId: "session-1",
          offset: 0,
          totalBytes: 3,
          eof: false,
          bytes: Uint8Array.from([1, 2, 3]).buffer,
        }),
      ),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "run.follow",
        {
          sessionId: "session-1",
          runId: "run-1",
          cursor: "cursor-1",
          limit: 1,
          waitMs: 1,
          pollMs: 25,
        },
        readResponse({
          reason: "deadline",
          status: {
            sessionId: "session-1",
            runId: "run-1",
            phase: "completed",
            liveActivity: null,
            createdAt: 1,
            updatedAt: 2,
            terminalAt: 2,
          },
          events: { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "cursor-1" },
        }),
      ),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "run.output_preview",
        { sessionId: "session-1", runId: "run-1", outputItemId: "output-1", maxBytes: 3 },
        readResponse({
          sessionId: "session-1",
          runId: "run-1",
          outputItemId: "output-1",
          storedByteLength: 3,
          contentSha256: "a".repeat(64),
          format: "binary",
          preview: "abc",
          previewByteLength: 3,
          truncated: false,
        }),
      ),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.list",
        { limit: 1 },
        {
          overallStatus: "success",
          value: { items: [] },
          persistence: { status: "read", effect: "unknown" },
        },
      ),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.delete",
        { sessionId: "session-1", idempotencyKey: "00000000-0000-4000-8000-000000000001" },
        writeResponse({
          sessionId: "session-1",
          cleanupToken: "00000000-0000-4000-8000-000000000001",
          deletedSessionCount: 1,
          localOnly: true,
          cleanupStatus: "pending",
        }),
      ),
    /response is invalid/u,
  );
});

test("runtime response projection correlates Session create by canonical Workspace identity", () => {
  const canonicalWorkspacePath = path.resolve(".");
  const equivalentWorkspacePath = `${canonicalWorkspacePath}${path.sep}workspace-alias${path.sep}..`;
  const payload = {
    title: "Title",
    workspacePath: equivalentWorkspacePath,
    idempotencyKey: randomUUID(),
    providerId: "provider-1",
    allowedAdditionalDirectories: [],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 1,
  } as const;
  const response = writeResponse({
    sessionId: "session-1",
    title: "Title",
    workspacePath: canonicalWorkspacePath,
    localRepositoryKey: null,
    repositoryName: null,
    lifecycleStatus: "active",
    createdAt: 1,
  });

  assert.doesNotThrow(() => snapshotRuntimeApplicationResponse("session.create", payload, response));
  assert.throws(
    () =>
      snapshotRuntimeApplicationResponse(
        "session.create",
        { ...payload, workspacePath: path.resolve("different-workspace") },
        response,
      ),
    /response is invalid/u,
  );
});

test("runtime response projection preserves a Session with zero child Run capacity", () => {
  const response = snapshotRuntimeApplicationResponse(
    "session.read",
    { sessionId: "session-1" },
    readResponse({
      session: {
        id: "session-1",
        title: "Title",
        providerId: "provider-1",
        workspacePath: path.resolve("."),
        localRepositoryKey: null,
        repositoryName: null,
        allowedAdditionalDirectoriesByteLength: 2,
        allowedAdditionalDirectoriesState: "inline",
        defaultCharacterId: "character-1",
        maxConcurrentChildRuns: 0,
        lifecycleStatus: "active",
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      },
      execution: { state: "not_started" },
    }),
  );

  const decoded = decodeRuntimeWireValue(response) as Readonly<{
    value: Readonly<{ session: Readonly<{ maxConcurrentChildRuns: number }> }>;
  }>;
  assert.equal(decoded.value.session.maxConcurrentChildRuns, 0);
});

test("runtime host bounds handshake and partial-line waits", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-frame-timeout-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(fakeRuntimeApplication()),
    handshakeTimeoutMs: 25,
    partialLineTimeoutMs: 25,
  });
  context.after(() => host.close().catch(() => undefined));

  const idle = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  await waitForEndpointClose(idle);

  const partial = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  const client = new TestRuntimeClient(partial, host.generationId);
  await client.handshake();
  await partial.write(Buffer.from('{"protocolVersion":'));
  await waitForEndpointClose(partial);
});

test("runtime partial-line deadline is absolute across slow-drip chunks", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-slow-drip-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const host = await startRuntimeHost({
    applicationDataRoot: fixtureRoot,
    dependencies: realEndpointDependencies(fakeRuntimeApplication()),
    partialLineTimeoutMs: 150,
  });
  context.after(() => host.close().catch(() => undefined));
  const connection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  const client = new TestRuntimeClient(connection, host.generationId);
  await client.handshake();

  await connection.write(Buffer.from("{"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await connection.write(Buffer.from('"'));
  assert.equal(await connection.read(AbortSignal.timeout(100)), null);
});

test("runtime host starts the real Application composition only after its endpoint and serves an isolated read", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-host-integration-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const host = await startRuntimeHost({ applicationDataRoot: fixtureRoot, timeoutMs: 10_000 });
  const connection = await connectRuntimeEndpoint(host.identity, { timeoutMs: 2_000 });
  context.after(async () => {
    await connection.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  });
  const client = new TestRuntimeClient(connection, host.generationId);
  await client.handshake();
  const response = await client.request("session.list", { limit: 1 });
  assert.equal(response.outcome, "success");
  if (response.outcome === "success") {
    assert.equal(JSON.stringify(decodeRuntimeWireValue(response.value)), JSON.stringify(readResponse({ items: [] })));
  }
  await connection.close();
  assert.deepEqual(await host.close(), { checkpoint: "completed" });
});

test("runtime dispatch owns the complete 21-operation allowlist and never spreads client authorization", async () => {
  const calls: Array<Readonly<{ name: string; request: Readonly<Record<string, unknown>>; signal: AbortSignal }>> = [];
  const application = completeDispatchApplication(calls);
  const signal = new AbortController().signal;
  const payloads = operationPayloads();

  for (const operation of RUNTIME_IPC_OPERATIONS) {
    const result = await dispatchRuntimeApplicationOperation(
      application,
      operation,
      { ...payloads[operation], authorization: { transport: "spoofed" } },
      signal,
    );
    assert.equal(result, operation);
  }

  assert.equal(calls.length, RUNTIME_IPC_OPERATIONS.length);
  for (const call of calls) {
    assert.deepEqual(call.request.context, { authorization: LOCAL_AUTHORIZATION });
    assert.equal(Object.hasOwn(call.request, "authorization"), false);
    assert.equal(call.signal, signal);
  }
  assert.equal(calls[0]?.request.idempotencyKey, payloads["session.create"].idempotencyKey);
});

class TestRuntimeClient {
  readonly clientId = randomUUID();
  #sequence = 0;

  constructor(
    readonly connection: RuntimeEndpointConnection,
    readonly generationId: string,
  ) {}

  async handshake(): Promise<void> {
    await this.connection.write(
      Buffer.from(
        encodeRuntimeIpcEnvelope({
          protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
          kind: "handshake_request",
          clientId: this.clientId,
        }),
      ),
    );
    const response = await readEnvelope(this.connection);
    assert.deepEqual(response, {
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "handshake_response",
      clientId: this.clientId,
      hostGenerationId: this.generationId,
    });
  }

  async request(operation: RuntimeIpcOperation, payload: RuntimeIpcOperationPayload): Promise<RuntimeIpcResponse> {
    this.#sequence += 1;
    const request = runtimeRequest(this.generationId, this.clientId, this.#sequence, operation, payload);
    await this.connection.write(Buffer.from(encodeRuntimeIpcEnvelope(request)));
    const response = await readEnvelope(this.connection);
    if (response.kind !== "response") throw new Error("Expected a runtime IPC response.");
    return response;
  }
}

function runtimeRequest(
  generationId: string,
  clientId: string,
  sequence: number,
  operation: RuntimeIpcOperation,
  payload: RuntimeIpcOperationPayload,
): RuntimeIpcRequest {
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "request",
    hostGenerationId: generationId,
    clientId,
    requestId: deriveRuntimeRequestId(clientId, sequence),
    requestSequence: sequence,
    operation,
    payload,
  };
}

async function readEnvelope(connection: RuntimeEndpointConnection): Promise<RuntimeIpcEnvelope> {
  const decoder = new RuntimeIpcJsonlDecoder();
  while (true) {
    const bytes = await connection.read();
    if (bytes === null) throw new Error("Runtime endpoint closed before a complete envelope arrived.");
    const envelopes: RuntimeIpcEnvelope[] = [];
    decoder.push(bytes, (envelope) => envelopes.push(envelope));
    if (envelopes.length > 0) return envelopes[0] as RuntimeIpcEnvelope;
  }
}

function readResponse(value: unknown): Readonly<Record<string, unknown>> {
  return {
    overallStatus: "success",
    value,
    persistence: { status: "read", effect: "none" },
  };
}

function writeResponse(value: unknown): Readonly<Record<string, unknown>> {
  return {
    overallStatus: "success",
    value,
    persistence: { status: "committed", effect: "none", replayed: false },
  };
}

function realEndpointDependencies(application: OwnedRuntimeApplication): RuntimeHostDependencies {
  return {
    resolveIdentity: resolveRuntimeOwnerIdentity,
    acquireClaim: acquireRuntimeOwnerClaim,
    createListener: createRuntimeEndpointListener,
    async startApplication() {
      return application;
    },
  };
}

type FakeMethod = (
  request: Readonly<Record<string, unknown>>,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

function fakeRuntimeApplication(
  overrides: Readonly<Record<string, FakeMethod>> = {},
  shutdown: RuntimeApplication["shutdown"] = async () => ({ checkpoint: "completed" }),
  fatalError: Promise<Error> = new Promise(() => undefined),
): OwnedRuntimeApplication {
  const fallback: FakeMethod = async () => {
    throw new Error("Unexpected fake Runtime Application operation.");
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
      status: overrides.status ?? fallback,
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
    fatalError,
    shutdown,
  } as unknown as OwnedRuntimeApplication;
}

function completeDispatchApplication(
  calls: Array<Readonly<{ name: string; request: Readonly<Record<string, unknown>>; signal: AbortSignal }>>,
): RuntimeApplication {
  const method =
    (name: RuntimeIpcOperation): FakeMethod =>
    async (request, options) => {
      if (options?.signal === undefined) throw new Error("Dispatch omitted its operation AbortSignal.");
      calls.push({ name, request, signal: options.signal });
      return name;
    };
  return fakeRuntimeApplication({
    create: method("session.create"),
    updateTitle: method("session.update_title"),
    list: method("session.list"),
    listLocalRepositories: method("session.list_local_repositories"),
    read: method("session.read"),
    readDirectoriesChunk: method("session.read_directories_chunk"),
    archive: method("session.archive"),
    unarchive: method("session.unarchive"),
    close: method("session.close"),
    delete: method("session.delete"),
    messages: method("session.messages"),
    messageContentChunk: method("session.message_content_chunk"),
    runs: method("session.runs"),
    status: method("run.status"),
    events: method("run.events"),
    follow: method("run.follow"),
    outputCounts: method("run.output_counts"),
    outputs: method("run.outputs"),
    outputPreview: method("run.output_preview"),
    outputChunk: method("run.output_chunk"),
    outputExport: method("run.output_export"),
  });
}

function operationPayloads(): Readonly<Record<RuntimeIpcOperation, RuntimeIpcOperationPayload>> {
  const idempotencyKey = randomUUID();
  return {
    "session.create": {
      title: "Title",
      workspacePath: path.resolve("."),
      idempotencyKey,
      providerId: "provider-1",
      allowedAdditionalDirectories: [],
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 1,
    },
    "session.update_title": { sessionId: "session-1", idempotencyKey, title: "Renamed" },
    "session.list": { limit: 1 },
    "session.list_local_repositories": { limit: 1 },
    "session.read": { sessionId: "session-1" },
    "session.read_directories_chunk": { sessionId: "session-1", offset: 0, maxBytes: 1 },
    "session.archive": { sessionId: "session-1", idempotencyKey },
    "session.unarchive": { sessionId: "session-1", idempotencyKey },
    "session.close": { sessionId: "session-1", idempotencyKey, expectedLifecycleStatus: "active" },
    "session.delete": { sessionId: "session-1", idempotencyKey },
    "session.messages": { sessionId: "session-1", limit: 1 },
    "session.message_content_chunk": { sessionId: "session-1", messageId: "message-1", offset: 0, maxBytes: 1 },
    "session.runs": { sessionId: "session-1", limit: 1 },
    "run.status": { sessionId: "session-1", runId: "run-1" },
    "run.events": { sessionId: "session-1", runId: "run-1", limit: 1 },
    "run.follow": { sessionId: "session-1", runId: "run-1", limit: 1, waitMs: 1, pollMs: 25 },
    "run.output_counts": { sessionId: "session-1", runId: "run-1" },
    "run.outputs": { sessionId: "session-1", runId: "run-1", limit: 1 },
    "run.output_preview": { sessionId: "session-1", runId: "run-1", outputItemId: "output-1", maxBytes: 1 },
    "run.output_chunk": {
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      offset: 0,
      maxBytes: 1,
    },
    "run.output_export": {
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      destination: path.resolve("output.bin"),
    },
  };
}

function fakeClaim(
  identity: RuntimeOwnerIdentity,
  events: string[],
): Extract<RuntimeOwnerClaim, { status: "acquired" }> {
  return {
    status: "acquired",
    endpointId: identity.endpointId,
    generationId: randomUUID(),
    holdEndpoint() {
      return () => undefined;
    },
    async release() {
      events.push("claim.release");
    },
  };
}

function blockingListener(events: string[]): RuntimeEndpointListener {
  return {
    accept(signal) {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    async close() {
      events.push("listener.close");
    },
  };
}

function singleConnectionListener(connection: RuntimeEndpointConnection): RuntimeEndpointListener {
  let accepted = false;
  return {
    async accept(signal) {
      if (!accepted) {
        accepted = true;
        return connection;
      }
      return await rejectWhenAborted(signal);
    },
    async close() {
      await connection.close();
    },
  };
}

class ScriptedRuntimeConnection implements RuntimeEndpointConnection {
  readonly kind = process.platform === "win32" ? "windows_named_pipe" : "unix_domain_socket";
  readonly endpointSecurity = { daclSddl: "test-only" };
  readonly input: Uint8Array[] = [];
  readonly readers: Array<(value: Uint8Array | null) => void> = [];
  closed = false;
  writes = 0;

  constructor(readonly peerPrincipalId: string) {}

  enqueue(value: Uint8Array): void {
    const reader = this.readers.shift();
    if (reader === undefined) this.input.push(value);
    else reader(value);
  }

  async read(signal?: AbortSignal): Promise<Uint8Array | null> {
    const value = this.input.shift();
    if (value !== undefined) return value;
    if (this.closed) return null;
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const onAbort = () => {
        remove();
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      const receive = (next: Uint8Array | null) => {
        remove();
        resolve(next);
      };
      const remove = () => {
        const index = this.readers.indexOf(receive);
        if (index >= 0) this.readers.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
      };
      this.readers.push(receive);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async write(_bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.writes += 1;
    if (this.writes === 1) return;
    await rejectWhenAborted(signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader(null);
  }
}

class DelayedTerminationWorker extends EventEmitter {
  terminateCalls = 0;
  #finished = false;
  readonly #termination: Promise<number>;
  #resolveTermination!: (exitCode: number) => void;

  constructor() {
    super();
    this.#termination = new Promise<number>((resolve) => {
      this.#resolveTermination = resolve;
    });
  }

  postMessage(): void {}

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.#termination;
  }

  finish(exitCode = 1): void {
    if (this.#finished) return;
    this.#finished = true;
    this.emit("exit", exitCode);
    this.#resolveTermination(exitCode);
  }
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
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the runtime host test condition.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function acquireRuntimeOwnerClaimEventually(identity: RuntimeOwnerIdentity) {
  const deadline = Date.now() + 2_000;
  while (true) {
    const claim = await acquireRuntimeOwnerClaim(identity);
    if (claim.status === "acquired") return claim;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the runtime owner claim.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForEndpointClose(connection: RuntimeEndpointConnection): Promise<void> {
  assert.equal(await connection.read(), null);
}
