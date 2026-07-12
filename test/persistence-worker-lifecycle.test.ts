import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { PersistenceClientError, PersistenceWorkerClient } from "../src/main/persistence-worker-client.js";
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
  await assert.rejects(crash, (error: unknown) => isClientError(error, "worker_crashed", "none"));
  await assert.rejects(delayedWrite, (error: unknown) => isClientError(error, "worker_crashed", "unknown"));
  assert.equal(client.state, "failed");
});

workerTest("shutdown correlates closed acknowledgements and surfaces crashes immediately", async () => {
  const wrongClosed = createFixtureClient("wrong-closed");
  await wrongClosed.start();
  await assert.rejects(wrongClosed.shutdown(20), (error: unknown) =>
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

test("payload chunks are bounded and transferred as owned ArrayBuffers", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE run_output_payloads (
      output_item_id TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      byte_length INTEGER NOT NULL
    ) STRICT;
  `);
  database
    .prepare("INSERT INTO run_output_payloads VALUES (?, ?, ?)")
    .run("payload-1", Uint8Array.from([1, 2, 3, 4, 5]), 5);

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
    payload: { payloadId: "payload-1", offset: 1, maxBytes: 3 },
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
    payload: { payloadId: "payload-1", offset: 0, maxBytes: 256 * 1024 + 1 },
  });
  await waitFor(() => messages.length === 2);
  const failure = messages[1];
  assert.equal(failure?.kind === "response" && !failure.ok && failure.error.code, "payload_chunk_too_large");
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
