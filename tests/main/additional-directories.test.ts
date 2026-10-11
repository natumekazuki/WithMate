import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  areDirectoryPathsEquivalent,
  isPathWithinDirectory,
  normalizeAllowedAdditionalDirectories,
} from "../../src-electron/files/additional-directories.js";
import { assertCapturedComposerAttachmentsAvailable, resolveComposerPreview } from "../../src-electron/files/composer-attachments.js";
import {
  appendSessionFilesDirectory,
  resolveSessionFilesDirectory,
} from "../../src-electron/files/session-files.js";
import { captureWorkspaceSnapshot } from "../../src-electron/platform/snapshot-ignore.js";

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
  // @test-value v2
  // kind = "security"
  // claim = "受付済み添付pathは内容変更を許容するが、現認可の取消・不存在・種類変更を実行前に拒否する"
  // oracle = { type = "issue", ref = "GitHub #801 添付path参照と現在root認可 / docs/design/database-schema.md Files Pin current authorization" }
  // fault = "保存済みdescriptorの認可を現在値へ照合せず、取消済みrootや不存在・別種類をproviderへ渡す"
  // observable = "捕捉したpathの検証成功または具体的な認可・存在・種類error"
  // observation_boundary = "public-boundary"
  // scope = "queue captured attachment filesystem authorization"
  // lifecycle = "permanent"
  // risk_tags = ["authorization", "privacy"]
  // distinction = "通常previewのtestは受付後の認可取消・target変更を検証せず、型やbuildは実filesystemを検証しない"
  // @end-test-value
  it("捕捉した添付pathを現認可と存在・種類で再検証する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-captured-attachment-"));
    const workspacePath = path.join(tempDirectory, "workspace");
    const externalPath = path.join(tempDirectory, "external");
    const filePath = path.join(externalPath, "input.txt");
    await mkdir(workspacePath);
    await mkdir(externalPath);
    await writeFile(filePath, "accepted contents", "utf8");
    try {
      const session = createSession(workspacePath, [externalPath]);
      const preview = await resolveComposerPreview(session, `@${filePath.replace(/\\/g, "/")}`);
      assert.deepEqual(preview.errors, []);
      assert.equal(preview.attachments.length, 1);
      const captured = structuredClone(preview.attachments);
      await writeFile(filePath, "changed contents", "utf8");
      await assertCapturedComposerAttachmentsAvailable(session, captured);
      assert.deepEqual(captured, preview.attachments);
      await assert.rejects(assertCapturedComposerAttachmentsAvailable(createSession(workspacePath), captured), /outside the workspace/);
      await rm(filePath);
      await assert.rejects(assertCapturedComposerAttachmentsAvailable(session, captured), /Path not found/);
      await mkdir(filePath);
      await assert.rejects(assertCapturedComposerAttachmentsAvailable(session, captured), /Expected a file/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("Windows path は大文字小文字が異なっても同じ directory として比較する", () => {
    assert.equal(
      areDirectoryPathsEquivalent(
        "C:\\Data\\WithMate\\session-files\\launch-1",
        "c:\\data\\withmate\\session-files\\launch-1",
        "win32",
      ),
      true,
    );
  });

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

  it("workspace root 自体を @path で添付できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-workspace-root-"));
    const workspacePath = path.join(tempDirectory, "workspace");
    await mkdir(workspacePath, { recursive: true });

    try {
      const preview = await resolveComposerPreview(
        createSession(workspacePath),
        `確認して @${workspacePath.replace(/\\/g, "/")}`,
      );

      assert.equal(preview.errors.length, 0);
      assert.equal(preview.attachments.length, 1);
      assert.equal(preview.attachments[0]?.kind, "folder");
      assert.equal(preview.attachments[0]?.workspaceRelativePath, ".");
      assert.equal(preview.attachments[0]?.isOutsideWorkspace, false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("session files directory 自体を @path で添付できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-files-root-"));
    const workspacePath = path.join(tempDirectory, "workspace");
    const userDataPath = path.join(tempDirectory, "user-data");
    await mkdir(workspacePath, { recursive: true });

    try {
      const session = createSession(workspacePath);
      const sessionFilesPath = resolveSessionFilesDirectory(userDataPath, session.id);
      await mkdir(sessionFilesPath, { recursive: true });

      const preview = await resolveComposerPreview(
        appendSessionFilesDirectory(userDataPath, session),
        `確認して @${sessionFilesPath.replace(/\\/g, "/")}`,
      );

      assert.equal(preview.errors.length, 0);
      assert.equal(preview.attachments.length, 1);
      assert.equal(preview.attachments[0]?.kind, "folder");
      assert.equal(preview.attachments[0]?.absolutePath, sessionFilesPath);
      assert.equal(preview.attachments[0]?.isOutsideWorkspace, true);
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
