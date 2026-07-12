import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-runtime-probe-"));
const sourcePath = path.join(tempDir, "source.sqlite3");
const backupPath = path.join(tempDir, "backup.sqlite3");

async function probeWorkerTransferAndCrash() {
  const worker = new Worker(
    `
      const { parentPort } = require("node:worker_threads");
      parentPort.once("message", (buffer) => {
        parentPort.postMessage({ byteLength: buffer.byteLength });
        setImmediate(() => { throw new Error("intentional probe crash"); });
      });
    `,
    { eval: true },
  );

  const payload = new ArrayBuffer(16 * 1024 * 1024);
  const messagePromise = new Promise((resolve) => worker.once("message", resolve));
  const errorPromise = new Promise((resolve) => worker.once("error", resolve));
  const exitPromise = new Promise((resolve) => worker.once("exit", resolve));

  worker.postMessage(payload, [payload]);
  assert.equal(payload.byteLength, 0, "transferred ArrayBuffer must be detached");

  const message = await messagePromise;
  assert.deepEqual(message, { byteLength: 16 * 1024 * 1024 });

  const error = await errorPromise;
  assert.match(error.message, /intentional probe crash/);
  assert.notEqual(await exitPromise, 0, "crashed Worker must exit unsuccessfully");
}

try {
  const db = new DatabaseSync(sourcePath);
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value BLOB) STRICT;");

  db.exec("BEGIN IMMEDIATE;");
  db.prepare("INSERT INTO probe (id, value) VALUES (?, ?)").run(1, new Uint8Array([1, 2, 3]));
  db.exec("ROLLBACK;");
  assert.equal(db.prepare("SELECT count(*) AS count FROM probe").get().count, 0);

  db.prepare("INSERT INTO probe (id, value) VALUES (?, ?)").run(1, new Uint8Array([1, 2, 3]));
  await backup(db, backupPath);
  db.close();

  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  const backedUp = backupDb.prepare("SELECT value FROM probe WHERE id = 1").get();
  assert.deepEqual(backedUp.value, new Uint8Array([1, 2, 3]));
  backupDb.close();

  await probeWorkerTransferAndCrash();

  console.log(
    JSON.stringify({
      node: process.version,
      transactionRollback: "ok",
      backup: "ok",
      blobTransferBytes: 16 * 1024 * 1024,
      workerCrashDetection: "ok",
    }),
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
