import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createSessionFilesDirectory,
  resolveSessionFilesDirectory,
} from "../../src-electron/files/session-files.js";

describe("session files directory", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "SessionFolder作成は同じIDの既存directoryを再利用せず拒否し、既存fileを保持する"
  // oracle = { type = "contract", ref = "src-electron/files/session-files.ts: createSessionFilesDirectory" }
  // fault = "同じIDのSessionFolderを再利用または上書きし、既存fileを失う"
  // observable = "2回目作成の拒否Errorと既存result.txtの内容"
  // observation_boundary = "public-boundary"
  // scope = "createSessionFilesDirectory collision"
  // lifecycle = "permanent"
  // impact = "別Sessionの保存物を破壊せずcollisionを明示する"
  // distinction = "filesystemの既存file保持とpublic rejectionを同一testで確認する"
  // @end-test-value
  it("createSessionFilesDirectory は既存 SessionFolder を再利用しない", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-session-files-"));
    const sessionId = "launch-collision";
    const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
    const retainedFilePath = path.join(directoryPath, "result.txt");

    try {
      assert.equal(
        await createSessionFilesDirectory(userDataPath, sessionId),
        directoryPath,
      );
      await writeFile(retainedFilePath, "retained", "utf8");

      await assert.rejects(
        createSessionFilesDirectory(userDataPath, sessionId),
        /A SessionFolder with the same ID already exists\./,
      );
      assert.equal(await readFile(retainedFilePath, "utf8"), "retained");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
