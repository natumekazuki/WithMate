import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BoundedSerialExecutor,
  executeWriteTransaction,
  PersistenceExecutorError,
} from "../src/persistence-worker/request-executor.js";

test("serial executor preserves FIFO order across reads and writes", async () => {
  const executor = new BoundedSerialExecutor(4);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = executor.submit("first", "write", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });
  const second = executor.submit("second", "read", () => {
    order.push("second");
  });
  const third = executor.submit("third", "write", () => {
    order.push("third");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["first:start", "first:end", "second", "third"]);
});

test("queued cancellation, duplicate IDs, queue limits, and closing fail before execution", async () => {
  const executor = new BoundedSerialExecutor(1);
  let releaseRunning!: () => void;
  const runningGate = new Promise<void>((resolve) => {
    releaseRunning = resolve;
  });
  const running = executor.submit("running", "write", () => runningGate);
  const queued = executor.submit("queued", "read", () => assert.fail("canceled request must not execute"));

  await assert.rejects(
    executor.submit("overflow", "read", () => undefined),
    (error: unknown) => error instanceof PersistenceExecutorError && error.code === "queue_full",
  );
  await assert.rejects(
    executor.submit("running", "read", () => undefined),
    (error: unknown) => error instanceof PersistenceExecutorError && error.code === "request_id_duplicate",
  );
  assert.equal(executor.cancel("queued"), "queued");
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof PersistenceExecutorError && error.code === "request_canceled",
  );
  assert.equal(executor.cancel("running"), "running");
  executor.closeAdmission();
  await assert.rejects(
    executor.submit("after-close", "read", () => undefined),
    (error: unknown) => error instanceof PersistenceExecutorError && error.code === "worker_closing",
  );

  releaseRunning();
  await running;
  await executor.whenIdle();
});

test("write transaction commits atomically and rejects async callbacks before invocation", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE events (ordinal INTEGER PRIMARY KEY, value TEXT NOT NULL);");

  executeWriteTransaction(database, () => {
    database.prepare("INSERT INTO events VALUES (?, ?)").run(1, "committed");
  });
  assert.throws(() =>
    executeWriteTransaction(database, () => {
      database.prepare("INSERT INTO events VALUES (?, ?)").run(2, "rolled-back");
      throw new Error("stop");
    }),
  );
  if (false) {
    // @ts-expect-error transaction callbackはPromiseを返せない。
    executeWriteTransaction(database, async () => undefined);
  }
  let continuedAfterAwait = false;
  const asyncOperation = async () => {
    database.prepare("INSERT INTO events VALUES (?, ?)").run(3, "before-await");
    await Promise.resolve();
    continuedAfterAwait = true;
    database.prepare("INSERT INTO events VALUES (?, ?)").run(4, "after-await");
  };
  assert.throws(() => executeWriteTransaction(database, asyncOperation as unknown as () => void));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(continuedAfterAwait, false);

  const rows = database.prepare("SELECT ordinal, value FROM events ORDER BY ordinal").all() as unknown as Array<{
    ordinal: number;
    value: string;
  }>;
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [{ ordinal: 1, value: "committed" }],
  );
  database.close();
});

test("Promise wrapper poisons the connection before async continuation can write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-transaction-"));
  const databasePath = path.join(directory, "transaction.sqlite3");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE events (ordinal INTEGER PRIMARY KEY);");
    let continuedAfterAwait = false;
    const asyncOperation = async () => {
      database.prepare("INSERT INTO events VALUES (?)").run(1);
      await Promise.resolve();
      continuedAfterAwait = true;
      database.prepare("INSERT INTO events VALUES (?)").run(2);
    };

    assert.throws(() => executeWriteTransaction(database, (() => asyncOperation()) as unknown as () => void));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(continuedAfterAwait, true);
    assert.equal(database.isOpen, false);

    const verification = new DatabaseSync(databasePath, { readOnly: true });
    const row = verification.prepare("SELECT count(*) AS count FROM events").get() as unknown as { count: number };
    assert.equal(row.count, 0);
    verification.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
