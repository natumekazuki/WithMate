import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import type { CompanionSession, CompanionSessionSummary } from "../../src/companion-state.js";
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
  id?: string;
  taskTitle?: string;
  companionBranch?: string;
}): CompanionSession {
  const id = input.id ?? "companion-session-1";
  return {
    id,
    groupId: "group-1",
    taskTitle: input.taskTitle ?? "Review task",
    status: "active",
    repoRoot: input.repoRoot,
    focusPath: "",
    targetBranch: "main",
    baseSnapshotRef: `refs/withmate/companion/${id}/base`,
    baseSnapshotCommit: input.baseSnapshotCommit,
    companionBranch: input.companionBranch ?? "withmate/companion/session-1",
    worktreePath: input.worktreePath,
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
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

function toCompanionSessionSummary(session: CompanionSession): CompanionSessionSummary {
  return {
    id: session.id,
    groupId: session.groupId,
    taskTitle: session.taskTitle,
    status: session.status,
    repoRoot: session.repoRoot,
    focusPath: session.focusPath,
    targetBranch: session.targetBranch,
    baseSnapshotRef: session.baseSnapshotRef,
    baseSnapshotCommit: session.baseSnapshotCommit,
    selectedPaths: session.selectedPaths,
    changedFiles: session.changedFiles,
    siblingWarnings: session.siblingWarnings,
    runState: session.runState,
    threadId: session.threadId,
    provider: session.provider,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    character: session.character,
    characterRoleMarkdown: session.characterRoleMarkdown,
    characterIconPath: session.characterIconPath,
    characterThemeColors: session.characterThemeColors,
    updatedAt: session.updatedAt,
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
      const headCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", headTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "hello\nreview\n", "utf8");
      await writeFile(path.join(worktreePath, "new-file.txt"), "new\n", "utf8");

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
        listCompanionSessionSummaries() {
          return [];
        },
        updateCompanionSession(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const snapshot = await service.getReviewSnapshot(session.id);

      assert.ok(snapshot);
      assert.equal(snapshot.mergeReadiness.status, "ready");
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

  it("selected files だけ target workspace に merge して CompanionSession を merged にする", async () => {
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
      const headCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", headTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "hello\nmerged\n", "utf8");
      await writeFile(path.join(worktreePath, "new-file.txt"), "not selected\n", "utf8");

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
        listCompanionSessionSummaries() {
          return [];
        },
        updateCompanionSession(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const merged = await service.mergeSelectedFiles(session.id, ["README.md"]);

      assert.equal(merged.session.status, "merged");
      assert.deepEqual(merged.session.selectedPaths, ["README.md"]);
      assert.deepEqual(merged.session.changedFiles, [
        { path: "new-file.txt", kind: "add" },
        { path: "README.md", kind: "edit" },
      ]);
      assert.deepEqual(merged.siblingWarnings, []);
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\nmerged\n");
      await assert.rejects(() => stat(path.join(repoRoot, "new-file.txt")));
      await assert.rejects(() => stat(worktreePath));
      await assert.rejects(() => git(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/withmate/companion/session-1"]));
      await assert.rejects(() => git(repoRoot, ["show-ref", "--verify", "--quiet", "refs/withmate/companion/session-1/base"]));
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("target workspace の selected file が base から変わっている場合は merge を止める", async () => {
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
      const headCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", headTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(repoRoot, "README.md"), "target drift\n", "utf8");
      await writeFile(path.join(worktreePath, "README.md"), "hello\nmerged\n", "utf8");

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
        listCompanionSessionSummaries() {
          return [];
        },
        updateCompanionSession(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target workspace が base snapshot から変わっている/,
      );
      assert.equal(session.status, "active");
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "target drift\n");
      await stat(worktreePath);
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("discard は target workspace を変更せず CompanionSession を discarded にする", async () => {
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
      const targetBaseHead = await git(repoRoot, ["rev-parse", "HEAD"]);
      const targetBaseTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", targetBaseTree, "-p", targetBaseHead, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "discarded\n", "utf8");

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
        listCompanionSessionSummaries() {
          return [];
        },
        updateCompanionSession(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const discarded = await service.discardSession(session.id);

      assert.equal(discarded.status, "discarded");
      assert.deepEqual(discarded.selectedPaths, []);
      assert.deepEqual(discarded.changedFiles, [{ path: "README.md", kind: "edit" }]);
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\n");
      await assert.rejects(() => stat(worktreePath));
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("target branch が base snapshot parent から進んでいる場合は readiness を blocked にする", async () => {
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
      const targetBaseHead = await git(repoRoot, ["rev-parse", "HEAD"]);
      const targetBaseTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", targetBaseTree, "-p", targetBaseHead, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "hello\nreview\n", "utf8");
      await writeFile(path.join(repoRoot, "target.txt"), "target\n", "utf8");
      await git(repoRoot, ["add", "target.txt"]);
      await git(repoRoot, ["commit", "-m", "target moved"]);

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
        listCompanionSessionSummaries() {
          return [];
        },
        updateCompanionSession(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const snapshot = await service.getReviewSnapshot(session.id);

      assert.equal(snapshot?.mergeReadiness.status, "blocked");
      assert.ok(snapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-branch-drift"));
      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target branch が Companion 作成時点から進んでいる/,
      );
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("selected path 以外でも target workspace が base から変わっている場合は merge を止める", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-review-"));
    const repoRoot = path.join(tempDirectory, "repo");
    const worktreePath = path.join(tempDirectory, "worktree");

    try {
      await mkdir(repoRoot, { recursive: true });
      await git(repoRoot, ["init", "-b", "main"]);
      await git(repoRoot, ["config", "user.name", "WithMate Test"]);
      await git(repoRoot, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
      await writeFile(path.join(repoRoot, "other.txt"), "base\n", "utf8");
      await git(repoRoot, ["add", "README.md", "other.txt"]);
      await git(repoRoot, ["commit", "-m", "initial"]);
      const baseSnapshotCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "hello\nreview\n", "utf8");
      await writeFile(path.join(repoRoot, "other.txt"), "dirty\n", "utf8");

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessionId === session.id ? session : null;
        },
        listCompanionSessionSummaries() {
          return [];
        },
        updateCompanionSession(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const snapshot = await service.getReviewSnapshot(session.id);

      assert.equal(snapshot?.mergeReadiness.status, "blocked");
      assert.ok(snapshot?.mergeReadiness.blockers.some((blocker) => blocker.paths?.includes("other.txt")));
      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target workspace が base snapshot から変わっている/,
      );
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\n");
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("同じ CompanionGroup の active sibling と selected path が重なる場合は warning を返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-review-"));
    const repoRoot = path.join(tempDirectory, "repo");
    const worktreePath = path.join(tempDirectory, "worktree");
    const siblingWorktreePath = path.join(tempDirectory, "sibling-worktree");

    try {
      await mkdir(repoRoot, { recursive: true });
      await git(repoRoot, ["init", "-b", "main"]);
      await git(repoRoot, ["config", "user.name", "WithMate Test"]);
      await git(repoRoot, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
      await git(repoRoot, ["add", "README.md"]);
      await git(repoRoot, ["commit", "-m", "initial"]);
      const targetBaseHead = await git(repoRoot, ["rev-parse", "HEAD"]);
      const targetBaseTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", targetBaseTree, "-p", targetBaseHead, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["branch", "withmate/companion/session-2", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await git(repoRoot, ["worktree", "add", siblingWorktreePath, "withmate/companion/session-2"]);
      await writeFile(path.join(worktreePath, "README.md"), "hello\nselected\n", "utf8");
      await writeFile(path.join(siblingWorktreePath, "README.md"), "hello\nsibling\n", "utf8");

      const session = createCompanionSession({
        repoRoot,
        worktreePath,
        baseSnapshotCommit,
        id: "companion-session-1",
        taskTitle: "Selected task",
        companionBranch: "withmate/companion/session-1",
      });
      const siblingSession = createCompanionSession({
        repoRoot,
        worktreePath: siblingWorktreePath,
        baseSnapshotCommit,
        id: "companion-session-2",
        taskTitle: "Sibling task",
        companionBranch: "withmate/companion/session-2",
      });
      const sessions = new Map<string, CompanionSession>([
        [session.id, session],
        [siblingSession.id, siblingSession],
      ]);
      const service = new CompanionReviewService({
        getCompanionSession(sessionId) {
          return sessions.get(sessionId) ?? null;
        },
        listCompanionSessionSummaries() {
          return [...sessions.values()].map(toCompanionSessionSummary);
        },
        updateCompanionSession(updatedSession) {
          sessions.set(updatedSession.id, updatedSession);
          return updatedSession;
        },
      });

      const result = await service.mergeSelectedFiles(session.id, ["README.md"]);

      assert.equal(result.session.status, "merged");
      assert.deepEqual(result.session.selectedPaths, ["README.md"]);
      assert.deepEqual(result.session.changedFiles, [{ path: "README.md", kind: "edit" }]);
      assert.deepEqual(result.session.siblingWarnings, [
        {
          sessionId: siblingSession.id,
          taskTitle: "Sibling task",
          paths: ["README.md"],
          message: "Sibling task と 1 file が重なっているよ。",
        },
      ]);
      assert.deepEqual(result.siblingWarnings, [
        {
          sessionId: siblingSession.id,
          taskTitle: "Sibling task",
          paths: ["README.md"],
          message: "Sibling task と 1 file が重なっているよ。",
        },
      ]);
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\nselected\n");
      await stat(siblingWorktreePath);
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await git(repoRoot, ["worktree", "remove", "--force", siblingWorktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
