import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { PersistenceWorkerClient } from "../dist/main/index.js";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-compiled-smoke-"));
const databasePath = path.join(tempDirectory, "runtime.sqlite3");
const workerUrl = new URL("../dist/persistence-worker/worker-entry.js", import.meta.url);
const client = new PersistenceWorkerClient({
  workerUrl,
  databasePath,
  legacyDatabasePaths: [],
});
const startedAt = performance.now();

try {
  await client.start();
  const readyAt = performance.now();
  assert.deepEqual(await client.request("runtime.ping", "read", {}), { ready: true });
  const pingedAt = performance.now();
  assert.deepEqual(await client.request("database.checkpoint", "maintenance", {}), { completed: true });
  const checkpointedAt = performance.now();
  assert.deepEqual(await client.shutdown(), { checkpoint: "completed" });
  const stoppedAt = performance.now();

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    assert.equal(fs.existsSync(`${databasePath}${suffix}`), false, `SQLite sidecar remained after shutdown: ${suffix}`);
  }

  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      startupMs: round(readyAt - startedAt),
      pingMs: round(pingedAt - readyAt),
      checkpointMs: round(checkpointedAt - pingedAt),
      shutdownMs: round(stoppedAt - checkpointedAt),
      totalMs: round(stoppedAt - startedAt),
      sqliteSidecars: "none",
    }),
  );
} finally {
  if (client.state === "ready") {
    await client.shutdown().catch(() => undefined);
  }
  fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function round(value) {
  return Math.round(value * 100) / 100;
}
