import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listIdentityBoundDirectory } from "../../src-electron/files/identity-bound-directory-listing.js";

test("listIdentityBoundDirectory は path が差し替えられても bound cwd の一覧だけを返す", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-bound-directory-"));
  const targetPath = path.join(basePath, "target");
  const movedPath = path.join(basePath, "moved");
  let resolveBound!: () => void;
  const identityBound = new Promise<void>((resolve) => {
    resolveBound = resolve;
  });
  let moved = false;
  try {
    await mkdir(targetPath);
    await writeFile(path.join(targetPath, "inside.txt"), "inside");
    const originalStats = await stat(targetPath);
    const listing = listIdentityBoundDirectory(targetPath, {
      delayAfterReadyMs: 300,
      onIdentityBound: resolveBound,
    });
    await identityBound;

    try {
      await rename(targetPath, movedPath);
      moved = true;
      await mkdir(targetPath);
      await writeFile(path.join(targetPath, "inside.txt"), "outside replacement");
    } catch (error) {
      assert.equal(process.platform, "win32");
      assert.equal((error as NodeJS.ErrnoException).code, "EBUSY");
    }

    const snapshot = await listing;
    assert.equal(snapshot.device, originalStats.dev);
    assert.equal(snapshot.inode, originalStats.ino);
    assert.deepEqual(snapshot.entries.map(({ name, kind, byteLength }) => ({ name, kind, byteLength })), [
      { name: "inside.txt", kind: "file", byteLength: 6 },
    ]);
    assert.equal(snapshot.maxConcurrentStats, 1);
  } finally {
    await rm(basePath, { recursive: true, force: true });
    if (moved) {
      await rm(movedPath, { recursive: true, force: true });
    }
  }
});

test("listIdentityBoundDirectory は entry metadata の並列取得数を制限する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-bound-directory-stats-"));
  try {
    await Promise.all(Array.from({ length: 96 }, (_, index) => (
      writeFile(path.join(basePath, `file-${index}.txt`), `${index}`)
    )));
    const snapshot = await listIdentityBoundDirectory(basePath);
    assert.equal(snapshot.entries.length, 96);
    assert.ok(snapshot.maxConcurrentStats > 1);
    assert.ok(snapshot.maxConcurrentStats <= 32);
    assert.ok(snapshot.entries.every((entry) => entry.modifiedAt !== null));
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "応答しないdirectory listing workerはdeadline後に終了し、呼び出し元へtimeoutを返してsettleする"
// oracle = { type = "contract", ref = "src-electron/files/identity-bound-directory-listing.ts#listIdentityBoundDirectory" }
// fault = "workerの応答待ちが無期限に残るか、timeout後もworkerのsettle通知が失われる"
// observable = "timeout error、worker start/settle callbacks、処理時間"
// observation_boundary = "public-boundary"
// scope = "identity-bound directory listing timeout"
// lifecycle = "permanent"
// impact = "ファイル一覧処理が呼び出し元を停止させ、後続のSession操作へ進めない"
// distinction = "応答しないworkerを明示的に起動し、deadline後の拒否とsettleを同時に観測する"
// @end-test-value
test("listIdentityBoundDirectory は応答しない worker を deadline 後に終了して settle する", async () => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "withmate-bound-directory-timeout-"));
  let started = 0;
  let settled = 0;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      () => listIdentityBoundDirectory(basePath, {
        hangAfterReady: true,
        timeoutMs: 100,
        onWorkerStarted: () => {
          started += 1;
        },
        onWorkerSettled: () => {
          settled += 1;
        },
      }),
      /The directory listing did not finish within 100 ms\./,
    );
    assert.equal(started, 1);
    assert.equal(settled, 1);
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});
