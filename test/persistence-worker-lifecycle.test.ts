import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { PersistenceClientError, PersistenceWorkerClient } from "../src/main/persistence-worker-client.js";
import { RepositoryWriteClient } from "../src/main/repository-write-client.js";
import { PERSISTENCE_PROTOCOL_VERSION, type WorkerToMainMessage } from "../src/shared/persistence-protocol.js";
import { PersistenceWorkerRuntime } from "../src/persistence-worker/worker-runtime.js";

const workerUrl = new URL("../src/persistence-worker/worker-entry.ts", import.meta.url);
const fixtureWorkerUrl = new URL("./fixtures/persistence-worker-fixture.ts", import.meta.url);
const workerOptions = { execArgv: ["--import", "tsx"] };
const workerTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;

workerTest("worker starts once, serves requests, checkpoints, and closes gracefully", async () => {
  await withTempDirectory(async (directory) => {
    const client = new PersistenceWorkerClient({
      workerUrl,
      databasePath: path.join(directory, "runtime.sqlite3"),
      legacyDatabasePaths: [],
      workerOptions,
    });

    assert.equal(client.state, "idle");
    assert.equal(client.start(), client.start());
    await client.start();
    assert.equal(client.state, "ready");
    assert.deepEqual(await client.request("runtime.ping", "read", {}), { ready: true });
    assert.ok(await client.request("database.checkpoint", "maintenance", {}));

    const shutdown = client.shutdown();
    await assert.rejects(client.request("runtime.ping", "read", {}), (error: unknown) =>
      isClientError(error, "worker_closing", "none"),
    );
    assert.deepEqual(await shutdown, { checkpoint: "completed" });
    assert.equal(client.state, "closed");
    assert.deepEqual(await client.shutdown(), { checkpoint: "completed" });
  });
});

workerTest("production Worker applies configured Run capacity", async () => {
  await withTempDirectory(async (directory) => {
    const client = new PersistenceWorkerClient({
      workerUrl,
      databasePath: path.join(directory, "capacity.sqlite3"),
      legacyDatabasePaths: [],
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProvider: 1,
      workerOptions,
    });
    await client.start();
    const repository = new RepositoryWriteClient(client);
    for (const [sessionId, idempotencyKey] of [
      ["session-capacity-1", "018f1f4e-7f0a-7000-8000-000000000301"],
      ["session-capacity-2", "018f1f4e-7f0a-7000-8000-000000000302"],
    ] as const) {
      const result = await repository.createSession({
        idempotencyKey,
        session: {
          id: sessionId,
          providerId: "provider",
          workspaceKey: "workspace",
          allowedAdditionalDirectories: [],
          defaultCharacterId: "character",
          maxConcurrentChildRuns: 2,
        },
      });
      assert.equal(result.ok, true);
    }
    const first = await repository.admitNormalRun(
      productionRunAdmission("session-capacity-1", "run-capacity-1", "018f1f4e-7f0a-7000-8000-000000000303"),
    );
    const second = await repository.admitNormalRun(
      productionRunAdmission("session-capacity-2", "run-capacity-2", "018f1f4e-7f0a-7000-8000-000000000304"),
    );
    assert.equal(first.ok, true);
    assert.equal(!second.ok && second.error.code, "capacity_exceeded");
    await client.shutdown();
  });
});

workerTest("BEGIN IMMEDIATE serializes capacity admission across database connections", async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = path.join(directory, "capacity-race.sqlite3");
    const options = {
      workerUrl,
      databasePath,
      legacyDatabasePaths: [],
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProvider: 1,
      workerOptions,
    } as const;
    const firstClient = new PersistenceWorkerClient(options);
    const secondClient = new PersistenceWorkerClient(options);
    await firstClient.start();
    await secondClient.start();
    const firstRepository = new RepositoryWriteClient(firstClient);
    const secondRepository = new RepositoryWriteClient(secondClient);
    for (const [sessionId, idempotencyKey] of [
      ["session-race-1", "018f1f4e-7f0a-7000-8000-000000000305"],
      ["session-race-2", "018f1f4e-7f0a-7000-8000-000000000306"],
    ] as const) {
      const result = await firstRepository.createSession({
        idempotencyKey,
        session: {
          id: sessionId,
          providerId: "provider",
          workspaceKey: "workspace",
          allowedAdditionalDirectories: [],
          defaultCharacterId: "character",
          maxConcurrentChildRuns: 2,
        },
      });
      assert.equal(result.ok, true);
    }

    const results = await Promise.all([
      firstRepository.admitNormalRun(
        productionRunAdmission("session-race-1", "run-race-1", "018f1f4e-7f0a-7000-8000-000000000307"),
      ),
      secondRepository.admitNormalRun(
        productionRunAdmission("session-race-2", "run-race-2", "018f1f4e-7f0a-7000-8000-000000000308"),
      ),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.error.code === "capacity_exceeded").length, 1);
    await Promise.all([firstClient.shutdown(), secondClient.shutdown()]);
  });
});

workerTest("startup failure is safe and does not enter a restart loop", async () => {
  const client = new PersistenceWorkerClient({
    workerUrl,
    databasePath: "relative.sqlite3",
    legacyDatabasePaths: [],
    workerOptions,
  });

  await assert.rejects(client.start(), (error: unknown) => isClientError(error, "worker_start_failed", "none"));
  assert.equal(client.state, "failed");
  assert.equal(client.start(), client.start());
});

workerTest("synchronous Worker and postMessage failures settle without leaking state", async () => {
  const invalidWorker = new PersistenceWorkerClient({
    workerUrl: fixtureWorkerUrl,
    databasePath: path.resolve("unused-test-database.sqlite3"),
    legacyDatabasePaths: [],
    workerOptions: { execArgv: ["--invalid-worker-option"] },
  });
  await assert.rejects(invalidWorker.start(), (error: unknown) => isClientError(error, "worker_start_failed", "none"));
  assert.equal(invalidWorker.state, "failed");

  const client = createFixtureClient();
  await client.start();
  await assert.rejects(client.request("Runtime.Ping", "read", {}), (error: unknown) =>
    isClientError(error, "protocol_invalid", "none"),
  );
  await assert.rejects(client.request("runtime..ping", "read", {}), (error: unknown) =>
    isClientError(error, "protocol_invalid", "none"),
  );
  await assert.rejects(client.request("test.echo", "read", { notCloneable: () => undefined }), (error: unknown) =>
    isClientError(error, "protocol_invalid", "none"),
  );
  assert.deepEqual(await client.request("test.echo", "read", {}), { operation: "test.echo" });
  await assert.rejects(client.shutdown(20), (error: unknown) =>
    isClientError(error, "worker_shutdown_forced", "unknown"),
  );
});

workerTest("timeout drops late responses without poisoning the worker", async () => {
  const client = createFixtureClient();
  await client.start();

  await assert.rejects(client.request("test.delay", "read", { delayMs: 80 }, { timeoutMs: 10 }), (error: unknown) =>
    isClientError(error, "request_timeout", "none"),
  );
  await assert.rejects(
    client.request("test.delay", "maintenance", { delayMs: 80 }, { timeoutMs: 10 }),
    (error: unknown) => isClientError(error, "request_timeout", "unknown"),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await client.request("test.echo", "read", {}), { operation: "test.echo" });

  await assert.rejects(client.shutdown(20), (error: unknown) =>
    isClientError(error, "worker_shutdown_forced", "unknown"),
  );
});

workerTest("worker crash rejects every in-flight write with unknown effect", async () => {
  const client = createFixtureClient();
  await client.start();

  const delayedWrite = client.request("test.delay", "write", { delayMs: 1_000 });
  const crash = client.request("test.crash", "maintenance", {});
  await assert.rejects(crash, (error: unknown) => isClientError(error, "worker_crashed", "unknown"));
  await assert.rejects(delayedWrite, (error: unknown) => isClientError(error, "worker_crashed", "unknown"));
  assert.equal(client.state, "failed");
});

workerTest("shutdown correlates closed acknowledgements and surfaces crashes immediately", async () => {
  const wrongClosed = createFixtureClient("wrong-closed");
  await wrongClosed.start();
  await assert.rejects(wrongClosed.shutdown(20), (error: unknown) =>
    isClientError(error, "worker_shutdown_forced", "unknown"),
  );

  const leakedAfterClosed = createFixtureClient("closed-with-leak");
  await leakedAfterClosed.start();
  await assert.rejects(leakedAfterClosed.shutdown(20), (error: unknown) =>
    isClientError(error, "worker_shutdown_forced", "unknown"),
  );

  const crashing = createFixtureClient("crash-on-shutdown");
  await crashing.start();
  const startedAt = Date.now();
  await assert.rejects(crashing.shutdown(2_000), (error: unknown) => isClientError(error, "worker_crashed", "none"));
  assert.ok(Date.now() - startedAt < 1_000);
});

test("request sequence rejects replay with constant memory", () => {
  const database = new DatabaseSync(":memory:");
  const messages: WorkerToMainMessage[] = [];
  const generationId = "018f1f4e-7f0a-7000-8000-000000000001";
  const firstRequestId = "018f1f4e-7f0a-7000-8000-000000000002";
  const runtime = new PersistenceWorkerRuntime(generationId, database, ":memory:", (message) => messages.push(message));

  for (let index = 0; index < 4_097; index += 1) {
    const suffix = (index + 2).toString(16).padStart(12, "0");
    runtime.handleMessage({
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "request",
      requestId: `018f1f4e-7f0a-7000-8000-${suffix}`,
      requestSequence: index + 1,
      operation: "unsupported.operation",
      requestClass: "write",
      payload: {},
    });
  }
  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: firstRequestId,
    requestSequence: 1,
    operation: "unsupported.operation",
    requestClass: "write",
    payload: {},
  });

  const duplicate = messages.at(-1);
  assert.equal(duplicate?.kind === "response" && !duplicate.ok && duplicate.error.code, "request_id_duplicate");
  database.close();
});

test("maintenance execution failures report unknown effect", async () => {
  await withTempDirectory(async (directory) => {
    const database = new DatabaseSync(":memory:");
    const messages: WorkerToMainMessage[] = [];
    const generationId = "018f1f4e-7f0a-7000-8000-000000000001";
    const runtime = new PersistenceWorkerRuntime(generationId, database, directory, (message) =>
      messages.push(message),
    );
    runtime.handleMessage({
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "request",
      requestId: "018f1f4e-7f0a-7000-8000-000000000002",
      requestSequence: 1,
      operation: "database.checkpoint",
      requestClass: "maintenance",
      payload: {},
    });
    await waitFor(() => messages.length === 1);
    const failure = messages[0];
    assert.equal(failure?.kind === "response" && !failure.ok && failure.error.effect, "unknown");
    database.close();
  });
});

test("payload chunks are bounded and transferred as owned ArrayBuffers", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL) STRICT;
    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL) STRICT;
    CREATE TABLE run_output_items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL) STRICT;
    CREATE TABLE run_output_payloads (
      output_item_id TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      byte_length INTEGER NOT NULL
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO sessions VALUES ('session-1', 'workspace-1');
    INSERT INTO runs VALUES ('run-1', 'session-1');
    INSERT INTO run_output_items VALUES ('payload-1', 'run-1'), ('payload-2', 'run-1'), ('payload-3', 'run-1');
  `);
  database
    .prepare("INSERT INTO run_output_payloads VALUES (?, ?, ?)")
    .run("payload-1", Uint8Array.from([1, 2, 3, 4, 5]), 5);
  const maximumChunk = new Uint8Array(256 * 1024);
  database
    .prepare("INSERT INTO run_output_payloads VALUES (?, ?, ?)")
    .run("payload-2", maximumChunk, maximumChunk.byteLength);
  const nearMaximumChunk = new Uint8Array(255 * 1024);
  database
    .prepare("INSERT INTO run_output_payloads VALUES (?, ?, ?)")
    .run("payload-3", nearMaximumChunk, nearMaximumChunk.byteLength);

  const messages: WorkerToMainMessage[] = [];
  const transfers: Array<readonly ArrayBuffer[]> = [];
  const generationId = "018f1f4e-7f0a-7000-8000-000000000001";
  const runtime = new PersistenceWorkerRuntime(generationId, database, ":memory:", (message, transferList) => {
    messages.push(message);
    transfers.push(transferList ?? []);
  });
  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000002",
    requestSequence: 1,
    operation: "payload.read_chunk",
    requestClass: "read",
    payload: payloadChunkRequest("payload-1", 1, 3),
  });
  await waitFor(() => messages.length === 1);

  const response = messages[0];
  assert.equal(response?.kind, "response");
  assert.equal(response?.kind === "response" && response.ok, true);
  if (response?.kind !== "response" || !response.ok) {
    assert.fail("expected successful payload response");
  }
  const result = response.result as { bytes: ArrayBuffer; eof: boolean; offset: number; totalBytes: number };
  assert.deepEqual([...new Uint8Array(result.bytes)], [2, 3, 4]);
  assert.deepEqual(
    { eof: result.eof, offset: result.offset, totalBytes: result.totalBytes },
    { eof: false, offset: 1, totalBytes: 5 },
  );
  assert.equal(transfers[0]?.[0], result.bytes);

  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000003",
    requestSequence: 2,
    operation: "payload.read_chunk",
    requestClass: "read",
    payload: payloadChunkRequest("payload-1", 0, 256 * 1024 + 1),
  });
  await waitFor(() => messages.length === 2);
  const failure = messages[1];
  assert.equal(failure?.kind === "response" && !failure.ok && failure.error.code, "payload_chunk_too_large");

  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000004",
    requestSequence: 3,
    operation: "payload.read_chunk",
    requestClass: "read",
    payload: payloadChunkRequest("payload-2", 0, 256 * 1024),
  });
  await waitFor(() => messages.length === 3);
  const combinedLimitFailure = messages[2];
  assert.equal(
    combinedLimitFailure?.kind === "response" && !combinedLimitFailure.ok && combinedLimitFailure.error.code,
    "response_too_large",
  );

  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000005",
    requestSequence: 4,
    operation: "payload.read_chunk",
    requestClass: "read",
    payload: payloadChunkRequest("payload-3", 0, 255 * 1024),
  });
  await waitFor(() => messages.length === 4);
  const nearBoundary = messages[3];
  assert.equal(nearBoundary?.kind === "response" && nearBoundary.ok, true);
  if (nearBoundary?.kind !== "response" || !nearBoundary.ok) {
    assert.fail("expected near-boundary payload response");
  }
  assert.equal((nearBoundary.result as { bytes: ArrayBuffer }).bytes.byteLength, 255 * 1024);

  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000006",
    requestSequence: 5,
    operation: "payload.read_chunk",
    requestClass: "read",
    payload: { ...payloadChunkRequest("payload-1", 0, 1), workspaceKey: "other" },
  });
  await waitFor(() => messages.length === 5);
  const scopeFailure = messages[4];
  assert.equal(
    scopeFailure?.kind === "response" && !scopeFailure.ok && scopeFailure.error.code,
    "payload_chunk_invalid",
  );
  database.close();
});

function createFixtureClient(databaseName = "unused-test-database.sqlite3"): PersistenceWorkerClient {
  return new PersistenceWorkerClient({
    workerUrl: fixtureWorkerUrl,
    databasePath: path.resolve(databaseName),
    legacyDatabasePaths: [],
    workerOptions,
  });
}

function payloadChunkRequest(outputItemId: string, offset: number, maxBytes: number) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    outputItemId,
    workspaceKey: "workspace-1",
    offset,
    maxBytes,
  };
}

function productionRunAdmission(sessionId: string, runId: string, idempotencyKey: string) {
  return {
    sessionId,
    workspaceKey: "workspace",
    idempotencyKey,
    message: { id: `message-${runId}`, contentBlocks: [{ type: "text", text: "hello" }] },
    run: {
      id: runId,
      executionSnapshot: {
        providerId: "provider",
        model: "test-model",
        reasoning: { effort: "medium" },
        approval: { mode: "on-request" },
        sandbox: { mode: "workspace-write" },
        workspace: { key: "workspace" },
        character: null,
      },
    },
    attemptId: `attempt-${runId}`,
    bindingIntent: { kind: "create" as const, bindingId: `binding-${runId}`, persistenceMode: "persistent" as const },
    dispatch: { providerRequest: { prompt: "hello" }, providerIdempotencyKey: null },
  };
}

function isClientError(error: unknown, code: string, effect: string): boolean {
  return (
    error instanceof PersistenceClientError &&
    error.persistenceError.code === code &&
    error.persistenceError.effect === effect
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not met");
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-worker-"));
  try {
    await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
