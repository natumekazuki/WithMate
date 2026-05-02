import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import type { CompanionMergeRun, CompanionSession, CompanionSessionSummary } from "../../src/companion-state.js";
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
    latestMergeRun: null,
    updatedAt: session.updatedAt,
  };
}

describe("CompanionReviewService", () => {
  it("terminal CompanionSession は merge run から read-only snapshot を作る", async () => {
    const session = {
      ...createCompanionSession({
        repoRoot: "F:/repo",
        worktreePath: "F:/repo/.withmate/removed-worktree",
        baseSnapshotCommit: "base",
      }),
      status: "merged" as const,
      selectedPaths: ["README.md"],
      changedFiles: [{ path: "README.md", kind: "edit" as const }],
      updatedAt: "2026-04-26 10:05",
    };
    const olderMergeRun: CompanionMergeRun = {
      id: "merge-run-0",
      sessionId: session.id,
      groupId: session.groupId,
      operation: "discard",
      selectedPaths: [],
      changedFiles: [{ path: "docs/old.md", kind: "delete" }],
      diffSnapshot: [],
      siblingWarnings: [],
      createdAt: "2026-04-26 10:03",
    };
    const mergeRun: CompanionMergeRun = {
      id: "merge-run-1",
      sessionId: session.id,
      groupId: session.groupId,
      operation: "merge",
      selectedPaths: ["README.md"],
      changedFiles: [
        { path: "README.md", kind: "edit" },
        { path: "src/app.ts", kind: "add" },
      ],
      diffSnapshot: [
        {
          kind: "edit",
          path: "README.md",
          summary: "README.md を更新",
          diffRows: [{ kind: "add", rightNumber: 2, rightText: "reviewed" }],
        },
      ],
      siblingWarnings: [],
      createdAt: "2026-04-26 10:04",
    };
    const service = new CompanionReviewService({
      getCompanionSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      listCompanionSessionSummaries() {
        return [];
      },
      updateCompanionSession(updatedSession) {
        return updatedSession;
      },
      listCompanionMergeRunsForSession(sessionId) {
        return sessionId === session.id ? [mergeRun, olderMergeRun] : [];
      },
    });

    const snapshot = await service.getReviewSnapshot(session.id);

    assert.equal(snapshot?.session.status, "merged");
    assert.equal(snapshot?.mergeReadiness.status, "warning");
    assert.deepEqual(snapshot?.changedFiles.map((file) => [file.kind, file.path, file.diffRows.length]), [
      ["edit", "README.md", 1],
    ]);
    assert.deepEqual(
      snapshot?.mergeRuns.map((run) => [run.id, run.operation, run.createdAt]),
      [
        ["merge-run-1", "merge", "2026-04-26 10:04"],
        ["merge-run-0", "discard", "2026-04-26 10:03"],
      ],
    );
    assert.equal("diffSnapshot" in (snapshot?.mergeRuns[0] ?? {}), false);
    assert.equal(snapshot?.mergeRuns[0]?.diffSnapshotAvailable, true);
  });

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
      assert.deepEqual(snapshot.mergeRuns, []);
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

  it("selected files だけ target workspace に merge して CompanionSession を削除扱いにする", async () => {
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
      const mergeRuns: CompanionMergeRun[] = [];
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
        createCompanionMergeRun(run) {
          mergeRuns.push(run);
          return run;
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
      assert.equal(session.status, "merged");
      assert.equal(mergeRuns.length, 1);
      assert.equal(mergeRuns[0]?.operation, "merge");
      assert.equal(mergeRuns[0]?.diffSnapshot.length, 2);
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

  it("Companion worktree の rename は delete と add として selected merge する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-review-"));
    const repoRoot = path.join(tempDirectory, "repo");
    const worktreePath = path.join(tempDirectory, "worktree");

    try {
      await mkdir(repoRoot, { recursive: true });
      await git(repoRoot, ["init", "-b", "main"]);
      await git(repoRoot, ["config", "user.name", "WithMate Test"]);
      await git(repoRoot, ["config", "user.email", "withmate@example.invalid"]);
      await git(repoRoot, ["config", "diff.renames", "true"]);
      await writeFile(path.join(repoRoot, "old.md"), "hello\n", "utf8");
      await git(repoRoot, ["add", "old.md"]);
      await git(repoRoot, ["commit", "-m", "initial"]);
      const headCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", headTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await git(worktreePath, ["mv", "old.md", "new.md"]);

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
      assert.deepEqual(snapshot?.changedFiles.map((change) => ({ path: change.path, kind: change.kind })), [
        { path: "new.md", kind: "add" },
        { path: "old.md", kind: "delete" },
      ]);

      await service.mergeSelectedFiles(session.id, ["old.md", "new.md"]);

      await assert.rejects(() => stat(path.join(repoRoot, "old.md")));
      assert.equal((await readFile(path.join(repoRoot, "new.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\n");
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("dirty workspace から作った base snapshot を baseline として selected merge する", async () => {
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
      await writeFile(path.join(repoRoot, "README.md"), "dirty baseline\n", "utf8");
      await writeFile(path.join(repoRoot, "memo.txt"), "draft\n", "utf8");
      await git(repoRoot, ["add", "-A"]);
      const dirtyTree = await git(repoRoot, ["write-tree"]);
      await git(repoRoot, ["reset"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", dirtyTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "dirty baseline\nreviewed\n", "utf8");
      await writeFile(path.join(worktreePath, "memo.txt"), "draft\nreviewed\n", "utf8");

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
      assert.equal(snapshot?.mergeReadiness.status, "ready");
      await service.mergeSelectedFiles(session.id, ["README.md", "memo.txt"]);

      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "dirty baseline\nreviewed\n");
      assert.equal((await readFile(path.join(repoRoot, "memo.txt"), "utf8")).replace(/\r\n/g, "\n"), "draft\nreviewed\n");
    } finally {
      await git(repoRoot, ["reset", "--hard", "HEAD"]).catch(() => undefined);
      await git(repoRoot, ["clean", "-fd"]).catch(() => undefined);
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
        /Companion 作成時点の snapshot/,
      );
      await assert.rejects(
        () => service.syncTarget(session.id),
        /target workspace が target branch の HEAD と一致していません/,
      );
      const stashResult = await service.stashTargetChanges(session.id);
      const appliedStash = stashResult.stash;
      if (!appliedStash) {
        throw new Error("target stash should be created");
      }
      assert.ok(appliedStash.ref.startsWith("stash@{"));
      assert.match(appliedStash.id, /^[0-9a-f-]{36}$/);
      assert.equal(await git(repoRoot, ["status", "--porcelain=v1"]), "");
      await git(repoRoot, ["stash", "apply", appliedStash.ref]);
      assert.match(await git(repoRoot, ["status", "--porcelain=v1"]), /README\.md/);
      const dropResult = await service.dropTargetStash(session.id);
      assert.equal(dropResult.stash, null);
      assert.equal(await git(repoRoot, ["stash", "list"]), "");
      const restashResult = await service.stashTargetChanges(session.id);
      assert.ok(restashResult.stash?.ref.startsWith("stash@{"));
      assert.equal(await git(repoRoot, ["status", "--porcelain=v1"]), "");
      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target stash が残っています/,
      );
      const restoreResult = await service.restoreTargetChanges(session.id);
      assert.equal(restoreResult.stash, null);
      assert.equal(session.status, "active");
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "target drift\n");
      assert.equal(await git(repoRoot, ["stash", "list"]), "");
      await stat(worktreePath);
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("target index に staged change が残っている場合は merge を止める", async () => {
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
      await writeFile(path.join(repoRoot, "README.md"), "staged target change\n", "utf8");
      await git(repoRoot, ["add", "README.md"]);
      await git(repoRoot, ["restore", "--worktree", "--source=HEAD", "README.md"]);

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
      assert.equal(snapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-worktree-dirty"), true);
      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target index が dirty/,
      );
      assert.equal(await git(repoRoot, ["diff", "--cached", "--name-only"]), "README.md");
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\n");
    } finally {
      await git(repoRoot, ["reset", "--hard", "HEAD"]).catch(() => undefined);
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("target branch 以外を checkout している場合は merge を止める", async () => {
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
      await git(repoRoot, ["branch", "side"]);
      const headCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", headTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await git(repoRoot, ["checkout", "side"]);
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

      const snapshot = await service.getReviewSnapshot(session.id);
      assert.equal(snapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-branch-mismatch"), true);
      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target workspace は main を checkout/,
      );
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\n");
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("discard は target workspace を変更せず CompanionSession を削除扱いにする", async () => {
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
      const mergeRuns: CompanionMergeRun[] = [];
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
        createCompanionMergeRun(run) {
          mergeRuns.push(run);
          return run;
        },
      });

      const discarded = await service.discardSession(session.id);

      assert.equal(discarded.status, "discarded");
      assert.deepEqual(discarded.selectedPaths, []);
      assert.deepEqual(discarded.changedFiles, [{ path: "README.md", kind: "edit" }]);
      assert.equal(session.status, "discarded");
      assert.equal(mergeRuns.length, 1);
      assert.equal(mergeRuns[0]?.operation, "discard");
      assert.equal(mergeRuns[0]?.diffSnapshot.length, 1);
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
      assert.equal(snapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-worktree-dirty"), false);
      await assert.rejects(
        () => service.mergeSelectedFiles(session.id, ["README.md"]),
        /target branch が Companion 作成時点から進んでいる/,
      );
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("Sync Target は target branch の進行を Companion worktree へ取り込んで readiness を戻す", async () => {
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
      await writeFile(path.join(worktreePath, "README.md"), "hello\ncompanion\n", "utf8");
      await writeFile(path.join(worktreePath, "new-file.txt"), "new\n", "utf8");

      await writeFile(path.join(repoRoot, "target.txt"), "target\n", "utf8");
      await git(repoRoot, ["add", "target.txt"]);
      await git(repoRoot, ["commit", "-m", "target update"]);

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      await git(repoRoot, ["update-ref", session.baseSnapshotRef, baseSnapshotCommit]);
      session = {
        ...session,
        selectedPaths: ["README.md", "missing.txt"],
      };
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
        updateCompanionSessionBaseSnapshot(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const blockedSnapshot = await service.getReviewSnapshot(session.id);
      assert.equal(blockedSnapshot?.mergeReadiness.status, "blocked");
      assert.ok(blockedSnapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-branch-drift"));
      assert.equal(blockedSnapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-worktree-dirty"), false);

      const result = await service.syncTarget(session.id);
      const targetHead = await git(repoRoot, ["rev-parse", "main"]);
      assert.equal(await git(repoRoot, ["rev-parse", `${result.session.baseSnapshotCommit}^`]), targetHead);
      assert.equal((await readFile(path.join(worktreePath, "target.txt"), "utf8")).replace(/\r\n/g, "\n"), "target\n");
      assert.equal((await readFile(path.join(worktreePath, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\ncompanion\n");
      assert.equal((await readFile(path.join(worktreePath, "new-file.txt"), "utf8")).replace(/\r\n/g, "\n"), "new\n");
      assert.deepEqual(result.session.selectedPaths, ["README.md"]);

      const syncedSnapshot = await service.getReviewSnapshot(session.id);
      assert.equal(syncedSnapshot?.mergeReadiness.status, "ready");
      assert.deepEqual(syncedSnapshot?.changedFiles.map((file) => [file.kind, file.path]), [
        ["add", "new-file.txt"],
        ["edit", "README.md"],
      ]);
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("Sync Target は target parent が同じ dirty snapshot を作り直さない", async () => {
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
      await writeFile(path.join(repoRoot, "ghost.txt"), "ghost\n", "utf8");
      await git(repoRoot, ["add", "ghost.txt"]);
      const mismatchedTree = await git(repoRoot, ["write-tree"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", mismatchedTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["reset", "--hard", "HEAD"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "companion.txt"), "companion\n", "utf8");

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      await git(repoRoot, ["update-ref", session.baseSnapshotRef, baseSnapshotCommit]);
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
        updateCompanionSessionBaseSnapshot(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      const blockedSnapshot = await service.getReviewSnapshot(session.id);
      assert.equal(blockedSnapshot?.mergeReadiness.status, "blocked");
      assert.ok(blockedSnapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-worktree-dirty"));

      const result = await service.syncTarget(session.id);
      assert.equal(result.session.baseSnapshotCommit, baseSnapshotCommit);
      await stat(path.join(worktreePath, "ghost.txt"));
      assert.equal((await readFile(path.join(worktreePath, "companion.txt"), "utf8")).replace(/\r\n/g, "\n"), "companion\n");
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("Sync Target は Companion と target branch の同一ファイル競合を検出して worktree を維持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-review-"));
    const repoRoot = path.join(tempDirectory, "repo");
    const worktreePath = path.join(tempDirectory, "worktree");

    try {
      await mkdir(repoRoot, { recursive: true });
      await git(repoRoot, ["init", "-b", "main"]);
      await git(repoRoot, ["config", "user.name", "WithMate Test"]);
      await git(repoRoot, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoRoot, "README.md"), "base\n", "utf8");
      await git(repoRoot, ["add", "README.md"]);
      await git(repoRoot, ["commit", "-m", "initial"]);
      const headCommit = await git(repoRoot, ["rev-parse", "HEAD"]);
      const headTree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      const baseSnapshotCommit = await git(repoRoot, ["commit-tree", headTree, "-p", headCommit, "-m", "snapshot"]);
      await git(repoRoot, ["branch", "withmate/companion/session-1", baseSnapshotCommit]);
      await git(repoRoot, ["worktree", "add", worktreePath, "withmate/companion/session-1"]);
      await writeFile(path.join(worktreePath, "README.md"), "companion\n", "utf8");

      await writeFile(path.join(repoRoot, "README.md"), "target\n", "utf8");
      await git(repoRoot, ["add", "README.md"]);
      await git(repoRoot, ["commit", "-m", "target update"]);

      let session = createCompanionSession({ repoRoot, worktreePath, baseSnapshotCommit });
      await git(repoRoot, ["update-ref", session.baseSnapshotRef, baseSnapshotCommit]);
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
        updateCompanionSessionBaseSnapshot(updatedSession) {
          session = updatedSession;
          return session;
        },
      });

      await assert.rejects(
        () => service.syncTarget(session.id),
        /Applied patch/,
      );
      assert.equal(await git(repoRoot, ["rev-parse", session.baseSnapshotRef]), baseSnapshotCommit);
      assert.equal(session.baseSnapshotCommit, baseSnapshotCommit);
      assert.equal((await readFile(path.join(worktreePath, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "companion\n");
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
        /Companion 作成時点の snapshot/,
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
      const mergeRuns: CompanionMergeRun[] = [];
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
        createCompanionMergeRun(run) {
          mergeRuns.push(run);
          return run;
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
      assert.equal(sessions.get(session.id)?.status, "merged");
      assert.equal(mergeRuns.length, 1);
      assert.equal(mergeRuns[0]?.siblingWarnings.length, 1);
      assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "hello\nselected\n");
      await stat(siblingWorktreePath);
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await git(repoRoot, ["worktree", "remove", "--force", siblingWorktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
