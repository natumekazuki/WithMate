import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { createCompanionWorkspace, resolveCompanionGitEligibility } from "../../src-electron/companion-git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

describe("companion-git", () => {
  it("Git repo 配下の workspace から repoRoot / focusPath / targetBranch を解決する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-git-"));
    const repoPath = path.join(tempDirectory, "repo");
    const srcPath = path.join(repoPath, "src");

    try {
      await mkdir(srcPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.name", "WithMate Test"]);
      await git(repoPath, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      const eligibility = await resolveCompanionGitEligibility(srcPath);

      assert.equal(eligibility.ok, true);
      if (eligibility.ok) {
        assert.equal(eligibility.repoRoot, repoPath.replace(/\\/g, "/"));
        assert.equal(eligibility.focusPath, "src");
        assert.equal(eligibility.targetBranch, "main");
      }
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("Git repo ではない directory は開始不可にする", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-git-"));

    try {
      const eligibility = await resolveCompanionGitEligibility(tempDirectory);

      assert.deepEqual(eligibility, {
        ok: false,
        reason: "Git repo root を解決できないよ。",
        warnings: [],
      });
    } finally {
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("working tree を snapshot commit に固定して companion worktree を作成する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-git-"));
    const repoPath = path.join(tempDirectory, "repo");
    const worktreePath = path.join(tempDirectory, "worktrees", "session-1");

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.name", "WithMate Test"]);
      await git(repoPath, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n\nchanged\n", "utf8");
      await writeFile(path.join(repoPath, "memo.txt"), "draft\n", "utf8");

      const artifacts = await createCompanionWorkspace({
        repoRoot: repoPath,
        sessionId: "companion-session-1",
        safeSessionId: "companion-session-1",
        companionBranch: "withmate/companion/companion-session-1",
        worktreePath,
      });

      assert.equal(artifacts.baseSnapshotRef, "refs/withmate/companion/companion-session-1/base");
      assert.match(artifacts.baseSnapshotCommit, /^[0-9a-f]{40}$/);
      assert.equal(await gitOutput(repoPath, ["rev-parse", artifacts.baseSnapshotRef]), artifacts.baseSnapshotCommit);
      assert.equal(
        await gitOutput(repoPath, ["rev-parse", "withmate/companion/companion-session-1"]),
        artifacts.baseSnapshotCommit,
      );
      assert.equal((await readFile(path.join(worktreePath, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "# demo\n\nchanged\n");
      assert.equal((await readFile(path.join(worktreePath, "memo.txt"), "utf8")).replace(/\r\n/g, "\n"), "draft\n");
      await stat(path.join(repoPath, ".git", "index"));
    } finally {
      await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
