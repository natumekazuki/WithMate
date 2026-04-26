import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { resolveCompanionGitEligibility } from "../../src-electron/companion-git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
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
});

