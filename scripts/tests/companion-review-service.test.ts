import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import type { CompanionSession } from "../../src/companion-state.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import { CompanionReviewService } from "../../src-electron/companion-review-service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

function createCompanionSession(input: {
  repoRoot: string;
  worktreePath: string;
  baseSnapshotCommit: string;
}): CompanionSession {
  return {
    id: "companion-session-1",
    groupId: "group-1",
    taskTitle: "Review task",
    status: "active",
    repoRoot: input.repoRoot,
    focusPath: "",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/session-1/base",
    baseSnapshotCommit: input.baseSnapshotCommit,
    companionBranch: "withmate/companion/session-1",
    worktreePath: input.worktreePath,
    runState: "idle",
    threadId: "",
    provider: "codex",
    catalogRevision: DEFAULT_CATALOG_REVISION,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    customAgentName: "",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    characterId: "char-1",
    character: "Mia",
    characterRoleMarkdown: "落ち着いて伴走する。",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    createdAt: "2026-04-26 10:00",
    updatedAt: "2026-04-26 10:00",
    messages: [],
  };
}

describe("CompanionReviewService", () => {
  it("base snapshot と shadow worktree から tracked / untracked の changed files を作る", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-review-"));
    const repoRoot = path.join(tempDirectory, "repo");
    const worktreePath = path.join(tempDirectory, "worktree");

    try {
      await mkdir(repoRoot, { recursive: true });
      await git(repoRoot, ["init", "-b", "main"]);
      await git(repoRoot, ["config", "user.name", "WithMate Test"]);
      await git(repoRoot, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
      await git(repoRoot, ["add", "README.md"]);
      await git(repoRoot, ["commit", "-m", "initial"]);
      const baseSnapshotCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "hello\nreview\n", "utf8");
      await writeFile(path.join(worktreePath, "new-file.txt"), "new\n", "utf8");

      const session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
      });

      const snapshot = await service.getReviewSnapshot(session.id);

      assert.ok(snapshot);
      assert.deepEqual(snapshot.changedFiles.map((file) => [file.kind, file.path]), [
        ["add", "new-file.txt"],
        ["edit", "README.md"],
      ]);
      assert.ok(
        snapshot.changedFiles
          .find((file) => file.path === "README.md")
          ?.diffRows.some((row) => row.kind === "add" && row.rightText === "review"),
      );
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
