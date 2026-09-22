import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { APP_DATABASE_V6_FILENAME } from "../../src-electron/storage/database-schema-v6.js";
import { createAppDatabaseBootstrapWorker } from "../../src-electron/storage/app-database-bootstrap-worker.js";
import { markMainThreadAsNonStorageOwner } from "../../src-electron/storage/sqlite-connection.js";

// @test-value v2
// kind = "contract"
// claim = "起動用のDB解決と診断はMainの同期SQLではなく同一Workerの公開commandを通る"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "Worker commandがDB解決・fresh作成・診断を実行せず、Main側の同期SQLへ処理が戻る"
// observable = "同期SQLiteを禁止した呼出し元からWorker APIで取得するdbPath・progress・runtimeCompatible"
// observation_boundary = "public-boundary"
// scope = "app-database-bootstrap-worker"
// lifecycle = "permanent"
// impact = "起動時にMain event loopを同期SQLite処理で塞がず、DB選択結果と診断結果を同じWorker経路から取得できる"
// distinction = "既存のapp-database-path単体testは同期関数本体を確認するが、実Workerのcommand dispatchとclient lifecycleは確認しない"
// @end-test-value
test("app database bootstrap worker は resolve と diagnostics のcommandを実Workerで処理する", async () => {
  markMainThreadAsNonStorageOwner();
  const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-database-bootstrap-worker-"));
  const worker = createAppDatabaseBootstrapWorker();
  try {
    const progressTitles: string[] = [];
    const resolved = await worker.resolveOrMigrate(
      { userDataPath, userDataPathOverrideApplied: false },
      (progress) => progressTitles.push(progress.title),
    );
    assert.equal(path.basename(resolved.dbPath), APP_DATABASE_V6_FILENAME);
    assert.ok(progressTitles.length > 0);

    const diagnostics = await worker.inspect({
      userDataPath,
      activeDatabasePath: resolved.dbPath,
      userDataPathOverrideApplied: false,
    });
    assert.equal(diagnostics.activeDatabasePath, resolved.dbPath);
    assert.equal(diagnostics.runtimeCompatible, true);
    assert.equal(diagnostics.valid, true);
  } finally {
    await worker.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
