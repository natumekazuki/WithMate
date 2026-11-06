import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, rename, rm, symlink, lstat, readlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureSessionLifecycleResource, prepareSessionLifecycleFiles } from "../../src-electron/session/session-lifecycle-files.js";

// @test-value v2
// kind = "invariant"
// claim = "記録済み作成resourceのfinal/stagingが消失・差替・symlinkなら別directoryを割り当てずpendingとして拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "receiptが示す所有実体を失った後に別directoryで成功を装うか、foreign entryを移動・置換する"
// observable = "再確保callbackの未実行、拒否、既存directory identity・file本文・link targetの保持"
// observation_boundary = "component-behavior"
// scope = "recorded SessionFolder publication recovery ownership"
// lifecycle = "permanent"
// impact = "中断後の誤った所有推定による別folderの破壊とSessionの誤復元を防ぐ"
// distinction = "native no-replace単体では記録済みinodeとstaging/finalの再照合を保証できない"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
it("keeps missing, replaced and linked creation resources pending without reallocating ownership", async () => {
  for (const state of ["both-missing", "staging-replaced", "staging-symlink", "final-foreign", "final-symlink"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-publication-owner-"));
    const stagingPath = path.join(directory, "staging");
    const finalPath = path.join(directory, "final");
    const parked = path.join(directory, "parked");
    await mkdir(stagingPath);
    const captured = await captureSessionLifecycleResource(stagingPath);
    const resource = { ...captured, path: finalPath, stagingPath };
    let recorded = false;
    try {
      if (state === "both-missing") await rm(stagingPath, { recursive: true });
      else if (state === "staging-replaced" || state === "staging-symlink") {
        await rename(stagingPath, parked);
        await writeFile(path.join(parked, "source.txt"), "original staging", "utf8");
        if (state === "staging-replaced") await mkdir(stagingPath);
        else await symlink(parked, stagingPath, process.platform === "win32" ? "junction" : "dir");
      } else if (state === "final-foreign") {
        await mkdir(finalPath);
        await writeFile(path.join(finalPath, "foreign.txt"), "keep foreign contents", "utf8");
      } else await symlink(stagingPath, finalPath, process.platform === "win32" ? "junction" : "dir");
      const existingPath = state.startsWith("staging-") ? stagingPath : state.startsWith("final-") ? finalPath : null;
      const before = existingPath ? await lstat(existingPath, { bigint: true }) : null;
      const link = state.endsWith("symlink") ? await readlink(existingPath!) : null;
      await assert.rejects(prepareSessionLifecycleFiles({ finalPath, resource, persistResource: async () => { recorded = true; } }));
      assert.equal(recorded, false);
      if (before) {
        const after = await lstat(existingPath!, { bigint: true });
        assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
      }
      if (link !== null) assert.equal(await readlink(existingPath!), link);
      if (state === "final-foreign") assert.equal(await readFile(path.join(finalPath, "foreign.txt"), "utf8"), "keep foreign contents");
      if (state.startsWith("staging-")) assert.equal(await readFile(path.join(parked, "source.txt"), "utf8"), "original staging");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
