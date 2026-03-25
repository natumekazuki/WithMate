import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  isPathWithinDirectory,
  normalizeAllowedAdditionalDirectories,
} from "../../src-electron/additional-directories.js";
import { resolveComposerPreview } from "../../src-electron/composer-attachments.js";
import { captureWorkspaceSnapshot } from "../../src-electron/snapshot-ignore.js";

function createSession(workspacePath: string, allowedAdditionalDirectories: string[] = []) {
  return buildNewSession({
    taskTitle: "allowlist",
    workspaceLabel: "workspace",
    workspacePath,
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    allowedAdditionalDirectories,
  });
}

describe("additional directories", () => {
  it("workspace 内 path を除外しつつ重複と入れ子を正規化できる", () => {
    const workspacePath = path.resolve("C:/repo");
    const normalized = normalizeAllowedAdditionalDirectories(workspacePath, [
      path.join(workspacePath, "src"),
      path.resolve("C:/shared"),
      path.resolve("C:/shared/docs"),
      path.resolve("C:/shared"),
      path.resolve("C:/external/reference"),
    ]);

    assert.deepEqual(normalized, [
      path.resolve("C:/external/reference"),
      path.resolve("C:/shared"),
    ]);
    assert.equal(isPathWithinDirectory(path.resolve("C:/shared/docs/file.md"), path.resolve("C:/shared")), true);
  });

  it("未許可の workspace 外 path は composer preview で拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-additional-dir-"));
    const workspacePath = path.join(tempDirectory, "workspace");
    const externalPath = path.join(tempDirectory, "external");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(externalPath, { recursive: true });
    await writeFile(path.join(workspacePath, "inside.txt"), "inside\n", "utf8");
    await writeFile(path.join(externalPath, "outside.txt"), "outside\n", "utf8");

    try {
      const blockedSession = createSession(workspacePath);
      const blockedPreview = await resolveComposerPreview(
        blockedSession,
        `確認して @${path.join(externalPath, "outside.txt").replace(/\\/g, "/")}`,
      );
      assert.equal(blockedPreview.attachments.length, 0);
      assert.equal(blockedPreview.errors.length, 1);

      const allowedSession = createSession(workspacePath, [externalPath]);
      const allowedPreview = await resolveComposerPreview(
        allowedSession,
        `確認して @${path.join(externalPath, "outside.txt").replace(/\\/g, "/")}`,
      );
      assert.equal(allowedPreview.errors.length, 0);
      assert.equal(allowedPreview.attachments.length, 1);
      assert.equal(allowedPreview.attachments[0]?.isOutsideWorkspace, true);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("snapshot は workspace と追加ディレクトリを同時に取得できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-additional-dir-"));
    const workspacePath = path.join(tempDirectory, "workspace");
    const externalPath = path.join(tempDirectory, "external");
    await mkdir(path.join(workspacePath, "src"), { recursive: true });
    await mkdir(externalPath, { recursive: true });
    await writeFile(path.join(workspacePath, "src", "main.ts"), "console.log('workspace');\n", "utf8");
    await writeFile(path.join(externalPath, "notes.md"), "# external\n", "utf8");

    try {
      const result = await captureWorkspaceSnapshot([workspacePath, externalPath]);
      assert.equal(result.snapshot.get("src/main.ts"), "console.log('workspace');\n");
      assert.equal(result.snapshot.get(path.join(path.resolve(externalPath), "notes.md").replace(/\\/g, "/")), "# external\n");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
