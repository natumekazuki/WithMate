import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildMateTalkRuntimeInstructionFiles,
  MateTalkRuntimeWorkspaceService,
  sanitizeMateTalkProfileContextText,
} from "../../src-electron/mate-talk-runtime-workspace.js";

describe("MateTalkRuntimeWorkspaceService", () => {
  it("prepareRun は固定 workspace を作り直し、lock を作成し専用 instruction を生成する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-mate-talk-runtime-"));

    try {
      const service = new MateTalkRuntimeWorkspaceService({ userDataPath });
      const instructionFiles = buildMateTalkRuntimeInstructionFiles({
        id: "mate-1",
        displayName: "タム",
        description: "テスト用の Mate",
        contextText: "保存場所: C:\\Users\\demo\\secret\n相対: context/ok.txt",
      });

      const result = await service.prepareRun();
      await service.regenerateInstructionFiles(instructionFiles);
      const expectedWorkspacePath = path.join(userDataPath, "mate-talk-runtime", "current");
      const expectedLockPath = path.join(userDataPath, "mate-talk-runtime", ".lock");

      assert.equal(result.workspacePath, expectedWorkspacePath);
      assert.equal(result.lockPath, expectedLockPath);
      assert.equal(await exists(result.lockPath), true);
      assert.equal(await exists(path.join(expectedWorkspacePath, "AGENTS.md")), true);
      assert.equal(await exists(path.join(expectedWorkspacePath, "mate-profile.md")), true);

      const profileText = await readFile(path.join(expectedWorkspacePath, "mate-profile.md"), "utf8");
      assert.match(profileText, /id: mate-1/);
      assert.match(profileText, /name: タム/);
      assert.match(profileText, /description: テスト用の Mate/);
      assert.doesNotMatch(profileText, /C:\\Users\\demo/);
      assert.doesNotMatch(profileText, /Users\\test/);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は非stale lock の場合は上書きしない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-mate-talk-runtime-"));
    const workspacePath = path.join(userDataPath, "mate-talk-runtime", "current");
    const lockPath = path.join(userDataPath, "mate-talk-runtime", ".lock");
    const existingLockTimestamp = Date.now();

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(lockPath, String(existingLockTimestamp), "utf8");
      await writeFile(path.join(workspacePath, "keep.txt"), "keep", "utf8");

      const service = new MateTalkRuntimeWorkspaceService({ userDataPath });

      await assert.rejects(
        () => service.prepareRun({ staleLockMs: 1_000 }),
        /already in use/i,
      );
      assert.equal(await readFile(lockPath, "utf8"), String(existingLockTimestamp));
      assert.equal(await readFile(path.join(workspacePath, "keep.txt"), "utf8"), "keep");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は lock が stale なら回復して続行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-mate-talk-runtime-"));
    const workspacePath = path.join(userDataPath, "mate-talk-runtime", "current");
    const lockPath = path.join(userDataPath, "mate-talk-runtime", ".lock");

    try {
      await mkdir(workspacePath, { recursive: true });
      const staleTimestamp = Date.now() - 11 * 60_000;
      await writeFile(lockPath, String(staleTimestamp), "utf8");
      await writeFile(path.join(workspacePath, "keep.txt"), "keep", "utf8");

      const service = new MateTalkRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun({ staleLockMs: 1_000 });
      const newTimestamp = Number(await readFile(result.lockPath, "utf8"));

      assert.equal(result.workspacePath, workspacePath);
      assert.ok(Number.isFinite(newTimestamp));
      assert.ok(newTimestamp > staleTimestamp + 1_000);
      assert.equal(await exists(workspacePath), true);
      assert.equal(await exists(lockPath), true);
      assert.equal(await exists(path.join(workspacePath, "keep.txt")), false);
      await service.completeRun();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は malformed lock でも上書きしない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-mate-talk-runtime-"));
    const workspacePath = path.join(userDataPath, "mate-talk-runtime", "current");
    const lockPath = path.join(userDataPath, "mate-talk-runtime", ".lock");

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(lockPath, "stale", "utf8");
      await writeFile(path.join(workspacePath, "keep.txt"), "keep", "utf8");

      const service = new MateTalkRuntimeWorkspaceService({ userDataPath });

      await assert.rejects(() => service.prepareRun(), /already in use/i);
      assert.equal(await readFile(lockPath, "utf8"), "stale");
      assert.equal(await readFile(path.join(workspacePath, "keep.txt"), "utf8"), "keep");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("withLock は処理完了後に lock を解放する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-mate-talk-runtime-"));
    const lockPath = path.join(userDataPath, "mate-talk-runtime", ".lock");

    try {
      const service = new MateTalkRuntimeWorkspaceService({ userDataPath });

      const result = await service.withLock(async () => {
        assert.equal(await exists(lockPath), true);
        return "ok";
      });

      assert.equal(result, "ok");
      assert.equal(await exists(lockPath), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("sanitizeMateTalkProfileContextText は絶対パスを除去する", () => {
    const input = "これは /Users/test/secret の内容です\nC:\\work\\repo のパスです\n外部: https://example.com/ok\n";
    const sanitized = sanitizeMateTalkProfileContextText(input);

    assert.equal(typeof sanitized, "string");
    assert.equal(Boolean(sanitized), true);
    assert.equal(sanitized?.includes("/Users/test/secret"), false);
    assert.equal(sanitized?.includes("C:\\work\\repo"), false);
  });

  it("regenerateInstructionFiles は path traversal を拒否する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-mate-talk-runtime-"));
    const outsidePath = path.join(userDataPath, "outside.md");

    try {
      const service = new MateTalkRuntimeWorkspaceService({ userDataPath });
      await service.prepareRun();

      await assert.rejects(
        () =>
          service.regenerateInstructionFiles([
            { relativePath: "../outside.md", content: "blocked\n" },
          ]),
        /path traversal/i,
      );
      await assert.rejects(
        () =>
          service.regenerateInstructionFiles([
            { relativePath: path.join("/", "absolute", "path.md"), content: "blocked\n" },
          ]),
        /relativePath/i,
      );

      assert.equal(await exists(outsidePath), false);
      await service.completeRun();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
