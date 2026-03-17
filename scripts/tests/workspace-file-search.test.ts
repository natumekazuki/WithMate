import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  clearWorkspaceFileIndex,
  DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS,
  searchWorkspaceFilePaths,
} from "../../src-electron/workspace-file-search.js";

describe("workspace-file-search", () => {
  it("cache clear 後は新規 file が再検索結果へ反映される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-clear-"));

    try {
      await writeFile(path.join(workspacePath, "alpha.txt"), "alpha", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "alpha"), ["alpha.txt"]);

      await mkdir(path.join(workspacePath, "generated"), { recursive: true });
      await writeFile(path.join(workspacePath, "generated", "fresh-file.ts"), "export {};\n", "utf8");

      clearWorkspaceFileIndex(workspacePath);

      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "fresh-file"), ["generated/fresh-file.ts"]);
    } finally {
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("TTL を過ぎた cache は自動再走査される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-search-ttl-"));

    try {
      await writeFile(path.join(workspacePath, "existing.txt"), "existing", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "later-file"), []);

      await writeFile(path.join(workspacePath, "later-file.txt"), "later", "utf8");
      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "later-file"), []);

      await new Promise((resolve) => setTimeout(resolve, DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100));

      assert.deepEqual(await searchWorkspaceFilePaths(workspacePath, "later-file"), ["later-file.txt"]);
    } finally {
      clearWorkspaceFileIndex(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
