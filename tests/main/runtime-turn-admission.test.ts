import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { runWithRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { MemoryV6WorkerClient } from "../../src-electron/memory/memory-v6-worker-client.js";
import { MemoryV6Storage } from "../../src-electron/memory/memory-v6-storage.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { encryptMemoryProtectedObjectPayload } from "../../src-electron/memory/memory-protected-object-crypto.js";
import { createMemoryProtectedObjectAad } from "../../src-electron/memory/memory-protected-object-importer.js";
import { exportMemoryProtectedObjectFile } from "../../src-electron/memory/memory-protected-object-exporter.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";

const target = { owner: { type: "user" as const, id: "local-user" as const }, scope: { type: "global" as const, id: "global" as const } };
const appendInput = {
  target, kind: "decision" as const, title: "Turn admission", body: "Captured turn only", preview: "Captured turn only", tags: [],
  source: { type: "agent" as const, sessionId: null, messageId: null, providerId: "codex" },
};

// @test-value v2
// kind = "contract"
// claim = "Worker起動待ちで取消されたturnのappendは保存せずeffect noneの拒否を返し、新turnのappendは保存できる"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "Main受付時だけ確認しWorker待機後の失効を見逃す、または失効拒否をunknown writeへ変換する"
// observable = "拒否例外の型とeffect、Workerから読み返したentry ID"
// observation_boundary = "public-boundary"
// scope = "MemoryV6WorkerClientの実Worker enqueue・SQLite保存・エラー復元"
// lifecycle = "permanent"
// impact = "取消済みproviderによる遅延保存と次turnの誤拒否を防ぐ"
// distinction = "HTTP受付testや型検査ではstructured clone後の共有失効状態とDB副作用を確認できない"
// @end-test-value
test("queued Memory worker mutation checks the captured turn after arrival", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-worker-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const client = new MemoryV6WorkerClient({ dbPath, workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url) });
  try {
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const pending = runWithRuntimeTurnAdmission({ state }, () => client.storage.appendEntry({ ...appendInput, id: "revoked-entry" }));
    Atomics.store(new Int32Array(state), 0, 1);
    await assert.rejects(Promise.resolve(pending), (error: unknown) => error instanceof RuntimeTurnInactiveError && error.effect === "none");
    assert.equal(await client.storage.getEntry("revoked-entry"), null);

    const nextState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    await runWithRuntimeTurnAdmission({ state: nextState }, () => client.storage.appendEntry({ ...appendInput, id: "next-entry" }));
    assert.equal((await client.storage.getEntry("next-entry"))?.id, "next-entry");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "最後のentry admission確認を過ぎてSQLite BEGIN execへ到達したMemory appendは、その後の取消をBEGIN戻り後に検出しrollbackしてentryを残さない"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "BEGIN前だけturnを確認し、BEGIN exec到達後に失効したtransactionをcommitする"
// observable = "BEGIN exec到達時のactive state、BEGIN戻り後のrevoked state、appendのeffect none失効例外、ROLLBACK execとSQLite entry一覧"
// observation_boundary = "public-boundary"
// scope = "実SQLite競合中のMemoryV6Storage transaction"
// lifecycle = "permanent"
// impact = "DB混雑時の取消済みproviderによる遅延保存を防ぐ"
// distinction = "Worker enqueueと非同期file testはproduction transactionのentry確認後・BEGIN exec到達後の別thread失効と実SQLite rollbackを確認しない"
// @end-test-value
test("Memory transaction rechecks revocation after SQLite BEGIN entry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-lock-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const storage = new MemoryV6Storage(dbPath);
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(workerData.dbPath);
    db.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    const start = new Int32Array(workerData.start);
    Atomics.wait(start, 0, 0);
    Atomics.store(new Int32Array(workerData.state), 0, 1);
    db.exec("COMMIT");
    db.close();
    parentPort.close();
  `)}`), { workerData: { dbPath, state, start } });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });
    const exec = DatabaseSync.prototype.exec;
    const commands: string[] = [];
    let stateAtBeginEntry: number | undefined;
    let stateAfterBegin: number | undefined;
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      commands.push(sql);
      if (sql === "BEGIN IMMEDIATE TRANSACTION") {
        stateAtBeginEntry = Atomics.load(new Int32Array(state), 0);
        // Notify only after production's last entry check, at the real BEGIN exec boundary.
        // The worker revokes before releasing its lock; native busy-wait entry is not assumed.
        Atomics.store(new Int32Array(start), 0, 1);
        Atomics.notify(new Int32Array(start), 0);
        exec.call(this, sql);
        stateAfterBegin = Atomics.load(new Int32Array(state), 0);
        return;
      }
      exec.call(this, sql);
    });
    assert.throws(() => runWithRuntimeTurnAdmission({ state }, () => storage.appendEntry(appendInput)),
      (error: unknown) => error instanceof RuntimeTurnInactiveError && error.effect === "none");
    assert.equal(stateAtBeginEntry, 0);
    assert.equal(stateAfterBegin, 1);
    assert.deepEqual(commands, ["BEGIN IMMEDIATE TRANSACTION", "ROLLBACK"]);
    assert.deepEqual(storage.listEntries({ target }).items, []);
  } finally {
    t.mock.restoreAll();
    await worker.terminate();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "file準備後にturnが取消されても準備objectを破棄し、Memory entryを保存しない"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "await prepare後に失効を確認しないか、拒否時に準備objectをcleanupしない"
// observable = "service拒否例外、discardされたobject ID、SQLiteのentry一覧"
// observation_boundary = "public-boundary"
// scope = "MemoryV6Service appendのfile準備・commit前検証・cleanup"
// lifecycle = "permanent"
// impact = "取消後の保存と未参照protected objectの漏れを防ぐ"
// distinction = "Worker単体testはMainでawaitするfile準備とcleanupを通らない"
// @end-test-value
test("Memory append cleans prepared files when the turn is revoked during preparation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-prepare-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const storage = new MemoryV6Storage(dbPath);
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const discarded: string[] = [];
  const service = new MemoryV6Service({
    storage,
    protectedObjectImporter: {
      inspect: async () => ({ originalBytes: 1, role: "other", mediaKind: "text", contentType: "text/plain", displayName: "one.txt", summary: "one" }),
      prepare: async () => {
        Atomics.store(new Int32Array(state), 0, 1);
        return { objectId: "a".repeat(32), role: "other", mediaKind: "text", contentType: "text/plain", displayName: "one.txt", summary: "one", originalBytes: 1, storedBytes: 1, sha256: "b".repeat(64), keyId: "c".repeat(32) };
      },
      discardPrepared: async ({ objectId }) => { discarded.push(objectId); },
    },
  });
  try {
    await assert.rejects(runWithRuntimeTurnAdmission({ state }, () => service.append(createLocalUserMemoryPrincipal(), {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION, target: { owner: "user", scope: "global" },
      kind: "decision", title: "Prepared", body: "Prepared", preview: "Prepared", tags: [],
      files: [{ path: join(directory, "one.txt"), summary: "one" }], idempotencyKey: "prepared-turn",
    })), RuntimeTurnInactiveError);
    assert.deepEqual(discarded, ["a".repeat(32)]);
    assert.deepEqual(storage.listEntries({ target }).items, []);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "protected payload読取待ちで取消されたexportは出力fileを作らずeffect noneで拒否する"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "export受付時だけturnを確認し、payload読取後に取消された出力を書き込む"
// observable = "export拒否例外と出力pathのENOENT"
// observation_boundary = "public-boundary"
// scope = "protected object exporterの復号・実filesystem作成境界"
// lifecycle = "permanent"
// impact = "取消済みturnによる機密fileの遅延書出しを防ぐ"
// distinction = "schema、HTTP、SQLite testでは復号前の非同期待機と実出力fileを確認できない"
// @end-test-value
test("protected object export rechecks admission after payload awaits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-turn-export-"));
  const outputPath = join(directory, "export.txt");
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const key = { keyId: "b".repeat(32), key: randomBytes(32) };
  const objectId = "a".repeat(32);
  const entryId = "export-entry";
  const plaintext = Buffer.from("protected");
  const encrypted = encryptMemoryProtectedObjectPayload({ plaintext, key, aad: createMemoryProtectedObjectAad({ entryId, objectId }) });
  try {
    await assert.rejects(runWithRuntimeTurnAdmission({ state }, () => exportMemoryProtectedObjectFile({
      keyStore: { readKey: async () => key },
      objectStore: { readObject: async () => {
        Atomics.store(new Int32Array(state), 0, 1);
        return encrypted.encryptedPayload;
      } },
    }, {
      metadata: { objectId, entryId, contentType: "text/plain", displayName: "export.txt", originalBytes: plaintext.length, storedBytes: encrypted.encryptedPayload.length, sha256: encrypted.sha256, keyId: key.keyId },
      outputPath,
    })), (error: unknown) => error instanceof RuntimeTurnInactiveError && error.effect === "none");
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
