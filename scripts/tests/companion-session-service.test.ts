import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { CompanionSessionService } from "../../src-electron/companion-session-service.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";

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

describe("CompanionSessionService", () => {
  it("CompanionSession 作成時に snapshot ref と shadow worktree を実体化する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-service-"));
    const repoPath = path.join(tempDirectory, "repo");
    const appDataPath = path.join(tempDirectory, "app-data");
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;
    let worktreePath = "";

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.name", "WithMate Test"]);
      await git(repoPath, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n\nservice\n", "utf8");

      storage = new CompanionStorage(dbPath);
      const service = new CompanionSessionService({ appDataPath, storage });
      const session = await service.createSession({
        taskTitle: "Shadow worktree",
        workspacePath: repoPath,
        provider: "codex",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
        characterId: "char-1",
        character: "Mia",
        characterRoleMarkdown: "落ち着いて伴走する。",
        characterIconPath: "icon.png",
        characterThemeColors: {
          main: "#6f8cff",
          sub: "#6fb8c7",
        },
      });
      worktreePath = session.worktreePath;

      assert.match(session.baseSnapshotRef, /^refs\/withmate\/companion\/companion-session-[^/]+\/base$/);
      assert.match(session.baseSnapshotCommit, /^[0-9a-f]{40}$/);
      assert.equal(await gitOutput(repoPath, ["rev-parse", session.baseSnapshotRef]), session.baseSnapshotCommit);
      assert.equal(await gitOutput(repoPath, ["rev-parse", session.companionBranch]), session.baseSnapshotCommit);
      assert.equal((await readFile(path.join(session.worktreePath, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "# demo\n\nservice\n");
      assert.equal(storage.getSession(session.id)?.baseSnapshotRef, session.baseSnapshotRef);
    } finally {
      if (worktreePath) {
        await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      }
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
