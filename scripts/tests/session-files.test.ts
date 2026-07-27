import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createSessionFilesDirectory,
  resolveSessionFilesDirectory,
} from "../../src-electron/session-files.js";

describe("session files directory", () => {
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
        /同じ ID の SessionFolder がすでに存在するよ。/,
      );
      assert.equal(await readFile(retainedFilePath, "utf8"), "retained");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
