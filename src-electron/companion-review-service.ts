import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ChangedFile } from "../src/runtime-state.js";
import type {
  CompanionMergeReadiness,
  CompanionMergeReadinessIssue,
  CompanionMergeSelectedFilesResult,
  CompanionReviewSnapshot,
  CompanionSyncTargetResult,
  CompanionSiblingCheckWarning,
} from "../src/companion-review-state.js";
import type { CompanionSession, CompanionSessionSummary } from "../src/companion-state.js";
import type { CompanionMergeRun } from "../src/companion-state.js";
import { currentTimestampLabel } from "../src/time-state.js";
import { cleanupCompanionWorkspaceArtifacts } from "./companion-git.js";
import { buildDiffRows, summarizeChangedFile } from "./provider-artifact.js";

const execFileAsync = promisify(execFile);

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

type GitCommandOptions = {
  env?: NodeJS.ProcessEnv;
};

type ChangedPath = {
  path: string;
  kind: ChangedFile["kind"];
};

export type CompanionReviewServiceDeps = {
  getCompanionSession(sessionId: string): CompanionSession | null;
  listCompanionSessionSummaries(): CompanionSessionSummary[];
  updateCompanionSession(session: CompanionSession): CompanionSession;
  updateCompanionSessionBaseSnapshot?(session: CompanionSession): CompanionSession;
  createCompanionMergeRun?(run: CompanionMergeRun): CompanionMergeRun;
  listCompanionMergeRunsForSession?(sessionId: string): CompanionMergeRun[];
};

async function runGit(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: options.env,
    });
    return {
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  } catch (error) {
    const candidate = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stderr = Buffer.isBuffer(candidate.stderr) ? candidate.stderr.toString("utf8") : candidate.stderr;
    const stdout = Buffer.isBuffer(candidate.stdout) ? candidate.stdout.toString("utf8") : candidate.stdout;
    throw new Error(stderr?.trim() || stdout?.trim() || candidate.message || "git command failed");
  }
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeSelectedPath(filePath: string): string {
  const normalized = normalizeRelativePath(filePath.trim());
  const segments = normalized.split("/");
  if (
    !normalized ||
    path.isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("merge 対象の file path が不正だよ。");
  }
  return normalized;
}

function parseNameStatusZ(output: string): ChangedPath[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const changes: ChangedPath[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 2;
      const nextPath = tokens[index];
      if (nextPath) {
        changes.push({ path: normalizeRelativePath(nextPath), kind: "edit" });
      }
      continue;
    }

    const nextPath = tokens[index + 1];
    index += 1;
    if (!nextPath) {
      continue;
    }

    const statusKind = status[0];
    const kind: ChangedFile["kind"] =
      statusKind === "A" ? "add" :
      statusKind === "D" ? "delete" :
      "edit";
    changes.push({ path: normalizeRelativePath(nextPath), kind });
  }
  return changes;
}

async function readGitFile(repoRoot: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const result = await runGit(repoRoot, ["show", `${ref}:${filePath}`]);
    return result.stdout;
  } catch {
    return null;
  }
}

async function readWorktreeFile(worktreePath: string, filePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(worktreePath, filePath), "utf8");
  } catch {
    return null;
  }
}

function toIssuePaths(changes: ChangedPath[]): string[] | undefined {
  const paths = changes.slice(0, 8).map((change) => change.path);
  if (changes.length > paths.length) {
    paths.push(`ほか ${changes.length - paths.length} 件`);
  }
  return paths.length > 0 ? paths : undefined;
}

export class CompanionReviewService {
  constructor(private readonly deps: CompanionReviewServiceDeps) {}

  async getReviewSnapshot(sessionId: string): Promise<CompanionReviewSnapshot | null> {
    const session = this.deps.getCompanionSession(sessionId);
    if (!session) {
      return null;
    }
    if (session.status !== "active") {
      return this.buildTerminalReviewSnapshot(session);
    }

    const changedPaths = await this.resolveChangedPaths(session);
    const changedFiles = await Promise.all(changedPaths.map((change) => this.buildChangedFile(session, change)));
    const mergeReadiness = await this.evaluateMergeReadiness(
      session,
      changedPaths.map((change) => change.path),
    );

    return {
      session,
      changedFiles,
      mergeRuns: this.deps.listCompanionMergeRunsForSession?.(session.id) ?? [],
      mergeReadiness,
      generatedAt: currentTimestampLabel(),
      warnings: [],
    };
  }

  private buildTerminalReviewSnapshot(session: CompanionSession): CompanionReviewSnapshot {
    const mergeRuns = this.deps.listCompanionMergeRunsForSession?.(session.id) ?? [];
    const latestRun = mergeRuns[0] ?? null;
    const changedFiles = latestRun && latestRun.diffSnapshot.length > 0
      ? latestRun.diffSnapshot
      : (latestRun?.changedFiles ?? session.changedFiles).map((change): ChangedFile => ({
        kind: change.kind,
        path: change.path,
        summary: summarizeChangedFile(change.kind, change.path),
        diffRows: [],
      }));

    return {
      session,
      changedFiles,
      mergeRuns,
      mergeReadiness: {
        status: "warning",
        blockers: [],
        warnings: [
          {
            kind: "lifecycle",
            message: "terminal CompanionSession のため read-only で表示しているよ。",
          },
        ],
        targetHead: "",
        baseParent: "",
        simulatedAt: latestRun?.createdAt ?? session.updatedAt,
      },
      generatedAt: currentTimestampLabel(),
      warnings: latestRun
        ? [`operation: ${latestRun.operation}`]
        : ["merge run history がないため session summary から表示しているよ。"],
    };
  }

  async mergeSelectedFiles(sessionId: string, selectedPaths: string[]): Promise<CompanionMergeSelectedFilesResult> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中のため merge できません。");
    }

    const normalizedSelectedPaths = [...new Set(selectedPaths.map(normalizeSelectedPath))];
    if (normalizedSelectedPaths.length === 0) {
      throw new Error("merge する file を選んでね。");
    }

    const changedPaths = await this.resolveChangedPaths(session);
    const changedPathByPath = new Map(changedPaths.map((change) => [change.path, change]));
    const selectedChanges = normalizedSelectedPaths.map((filePath) => {
      const change = changedPathByPath.get(filePath);
      if (!change) {
        throw new Error(`changed files にない file は merge できません: ${filePath}`);
      }
      return change;
    });

    const readiness = await this.evaluateMergeReadiness(session, normalizedSelectedPaths);
    if (readiness.blockers.length > 0) {
      throw new Error(readiness.blockers.map((blocker) => blocker.message).join("\n"));
    }

    const diffSnapshot = await Promise.all(changedPaths.map((change) => this.buildChangedFile(session, change)));

    for (const change of selectedChanges) {
      await this.applySelectedChange(session, change);
    }
    const siblingWarnings = await this.checkSiblingImpact(session, selectedChanges);

    await cleanupCompanionWorkspaceArtifacts({
      repoRoot: session.repoRoot,
      baseSnapshotRef: session.baseSnapshotRef,
      baseSnapshotCommit: session.baseSnapshotCommit,
      companionBranch: session.companionBranch,
      worktreePath: session.worktreePath,
    });

    const completedAt = currentTimestampLabel();
    const storedSession = this.deps.updateCompanionSession({
      ...session,
      status: "merged",
      selectedPaths: normalizedSelectedPaths,
      changedFiles: changedPaths,
      siblingWarnings,
      runState: "idle",
      updatedAt: completedAt,
    });
    this.deps.createCompanionMergeRun?.({
      id: randomUUID(),
      sessionId: storedSession.id,
      groupId: storedSession.groupId,
      operation: "merge",
      selectedPaths: normalizedSelectedPaths,
      changedFiles: changedPaths,
      diffSnapshot,
      siblingWarnings,
      createdAt: completedAt,
    });
    return {
      session: storedSession,
      siblingWarnings,
    };
  }

  async discardSession(sessionId: string): Promise<CompanionSession> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中のため discard できません。");
    }

    const changedPaths = await this.resolveChangedPaths(session);
    const diffSnapshot = await Promise.all(changedPaths.map((change) => this.buildChangedFile(session, change)));

    await cleanupCompanionWorkspaceArtifacts({
      repoRoot: session.repoRoot,
      baseSnapshotRef: session.baseSnapshotRef,
      baseSnapshotCommit: session.baseSnapshotCommit,
      companionBranch: session.companionBranch,
      worktreePath: session.worktreePath,
    });

    const completedAt = currentTimestampLabel();
    const storedSession = this.deps.updateCompanionSession({
      ...session,
      status: "discarded",
      selectedPaths: [],
      changedFiles: changedPaths,
      siblingWarnings: [],
      runState: "idle",
      updatedAt: completedAt,
    });
    this.deps.createCompanionMergeRun?.({
      id: randomUUID(),
      sessionId: storedSession.id,
      groupId: storedSession.groupId,
      operation: "discard",
      selectedPaths: [],
      changedFiles: changedPaths,
      diffSnapshot,
      siblingWarnings: [],
      createdAt: completedAt,
    });
    return storedSession;
  }

  async syncTarget(sessionId: string): Promise<CompanionSyncTargetResult> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中のため Sync Target できません。");
    }

    const baseParent = await this.resolveBaseSnapshotParent(session);
    const targetHead = await this.resolveTargetHead(session);
    if (!baseParent || !targetHead) {
      throw new Error("target branch または base snapshot を解決できません。");
    }
    if (baseParent === targetHead) {
      return { session };
    }
    if (!(await this.isAncestor(session.repoRoot, baseParent, targetHead))) {
      throw new Error("target branch の履歴が base snapshot から分岐しています。Companion の再作成を検討してください。");
    }

    await this.assertTargetWorkspaceClean(session, targetHead);

    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-sync-target-"));
    const patchPath = path.join(tempDirectory, "companion.patch");
    const newBaseSnapshotCommit = await this.createBaseSnapshotFromTarget(session, targetHead);
    let hasPatch = false;
    let mutatedWorktree = false;

    try {
      const patchText = await this.createCompanionPatch(session);
      hasPatch = patchText.trim().length > 0;
      if (hasPatch) {
        await writeFile(patchPath, patchText, "utf8");
        await this.checkPatchApplies(session, newBaseSnapshotCommit, patchPath);
      }

      await runGit(session.repoRoot, ["update-ref", session.baseSnapshotRef, newBaseSnapshotCommit]);
      await runGit(session.worktreePath, ["reset", "--hard", newBaseSnapshotCommit]);
      await runGit(session.worktreePath, ["clean", "-fd"]);
      mutatedWorktree = true;
      if (hasPatch) {
        await runGit(session.worktreePath, ["apply", "--3way", "--whitespace=nowarn", patchPath]);
      }

      const updatedSession: CompanionSession = {
        ...session,
        baseSnapshotCommit: newBaseSnapshotCommit,
        updatedAt: currentTimestampLabel(),
      };
      const changedPaths = await this.resolveChangedPaths(updatedSession);
      const changedPathSet = new Set(changedPaths.map((change) => change.path));
      updatedSession.changedFiles = changedPaths.map((change) => ({ kind: change.kind, path: change.path }));
      updatedSession.selectedPaths = updatedSession.selectedPaths.filter((filePath) => changedPathSet.has(filePath));
      if (!this.deps.updateCompanionSessionBaseSnapshot) {
        throw new Error("Sync Target 用の CompanionSession 保存 API が設定されていません。");
      }
      const updated = this.deps.updateCompanionSessionBaseSnapshot(updatedSession);
      return { session: updated };
    } catch (error) {
      await runGit(session.repoRoot, ["update-ref", session.baseSnapshotRef, session.baseSnapshotCommit]).catch(() => undefined);
      if (mutatedWorktree) {
        await runGit(session.worktreePath, ["reset", "--hard", session.baseSnapshotCommit]).catch(() => undefined);
        await runGit(session.worktreePath, ["clean", "-fd"]).catch(() => undefined);
        if (hasPatch) {
          await runGit(session.worktreePath, ["apply", "--3way", "--whitespace=nowarn", patchPath]).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private requireActiveSession(sessionId: string): CompanionSession {
    const session = this.deps.getCompanionSession(sessionId);
    if (!session) {
      throw new Error("対象 CompanionSession が見つかりません。");
    }
    if (session.status !== "active") {
      throw new Error("active ではない CompanionSession は操作できません。");
    }
    return session;
  }

  private async resolveChangedPaths(session: CompanionSession): Promise<ChangedPath[]> {
    const diffOutput = (await runGit(session.worktreePath, ["diff", "--name-status", "-z", session.baseSnapshotCommit, "--"])).stdout;
    const trackedChanges = parseNameStatusZ(diffOutput);
    const untrackedOutput = (await runGit(session.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout;
    const untrackedChanges = untrackedOutput
      .split("\0")
      .filter((filePath) => filePath.trim().length > 0)
      .map((filePath) => ({ path: normalizeRelativePath(filePath), kind: "add" as const }));

    const changes = new Map<string, ChangedPath>();
    for (const change of [...trackedChanges, ...untrackedChanges]) {
      changes.set(change.path, change);
    }
    return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private async evaluateMergeReadiness(
    session: CompanionSession,
    selectedPaths: string[],
  ): Promise<CompanionMergeReadiness> {
    const blockers: CompanionMergeReadinessIssue[] = [];
    const warnings: CompanionMergeReadinessIssue[] = [];

    if (session.status !== "active") {
      blockers.push({
        kind: "lifecycle",
        message: "active ではない CompanionSession は merge できません。",
      });
    }
    if (session.runState === "running") {
      blockers.push({
        kind: "lifecycle",
        message: "Companion が実行中のため merge できません。",
      });
    }

    const baseParent = await this.resolveBaseSnapshotParent(session);
    const targetHead = await this.resolveTargetHead(session);
    if (baseParent && targetHead && baseParent !== targetHead) {
      blockers.push({
        kind: "target-branch-drift",
        message: "target branch が Companion 作成時点から進んでいるため merge できません。",
      });
    }

    const targetTree = await this.captureTargetWorktreeTree(session);
    const baseTree = await this.resolveCommitTree(session.repoRoot, session.baseSnapshotCommit);
    if (targetTree && baseTree && targetTree !== baseTree) {
      const dirtyPaths = await this.resolveTreeDiffPaths(session.repoRoot, baseTree, targetTree);
      blockers.push({
        kind: "target-worktree-dirty",
        message: "target workspace が base snapshot から変わっているため merge できません。",
        paths: toIssuePaths(dirtyPaths),
      });
    }

    if (selectedPaths.length > 0) {
      try {
        await this.simulateSelectedFilesMerge(session, selectedPaths);
      } catch (error) {
        blockers.push({
          kind: "merge-simulation",
          message: error instanceof Error ? error.message : "merge simulation に失敗したよ。",
        });
      }
    } else {
      warnings.push({
        kind: "merge-simulation",
        message: "merge 対象 file が選択されていません。",
      });
    }

    return {
      status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready",
      blockers,
      warnings,
      targetHead,
      baseParent,
      simulatedAt: currentTimestampLabel(),
    };
  }

  private async checkSiblingImpact(
    session: CompanionSession,
    selectedChanges: ChangedPath[],
  ): Promise<CompanionSiblingCheckWarning[]> {
    const selectedPathSet = new Set(selectedChanges.map((change) => change.path));
    const siblingSummaries = this.deps.listCompanionSessionSummaries()
      .filter((summary) =>
        summary.groupId === session.groupId &&
        summary.id !== session.id &&
        summary.status === "active"
      );
    const warnings: CompanionSiblingCheckWarning[] = [];

    for (const summary of siblingSummaries) {
      const sibling = this.deps.getCompanionSession(summary.id);
      if (!sibling) {
        continue;
      }
      let siblingChangedPaths: ChangedPath[];
      try {
        siblingChangedPaths = await this.resolveChangedPaths(sibling);
      } catch {
        warnings.push({
          sessionId: sibling.id,
          taskTitle: sibling.taskTitle,
          paths: [],
          message: `${sibling.taskTitle} の sibling check に失敗したよ。`,
        });
        continue;
      }
      const overlapPaths = siblingChangedPaths
        .map((change) => change.path)
        .filter((filePath) => selectedPathSet.has(filePath));
      if (overlapPaths.length === 0) {
        continue;
      }
      warnings.push({
        sessionId: sibling.id,
        taskTitle: sibling.taskTitle,
        paths: overlapPaths,
        message: `${sibling.taskTitle} と ${overlapPaths.length} file が重なっているよ。`,
      });
    }

    return warnings;
  }

  private async resolveBaseSnapshotParent(session: CompanionSession): Promise<string> {
    try {
      return (await runGit(session.repoRoot, ["rev-parse", `${session.baseSnapshotCommit}^`])).stdout.trim();
    } catch {
      return "";
    }
  }

  private async resolveTargetHead(session: CompanionSession): Promise<string> {
    try {
      return (await runGit(session.repoRoot, ["rev-parse", session.targetBranch])).stdout.trim();
    } catch {
      return "";
    }
  }

  private async isAncestor(repoRoot: string, ancestorCommit: string, descendantCommit: string): Promise<boolean> {
    try {
      await runGit(repoRoot, ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit]);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveCommitTree(repoRoot: string, commit: string): Promise<string> {
    try {
      return (await runGit(repoRoot, ["rev-parse", `${commit}^{tree}`])).stdout.trim();
    } catch {
      return "";
    }
  }

  private async captureTargetWorktreeTree(session: CompanionSession): Promise<string> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-target-index-"));
    const tempIndexPath = path.join(tempDirectory, "index");
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
    };

    try {
      await runGit(session.repoRoot, ["read-tree", "HEAD"], { env: gitEnv });
      await runGit(session.repoRoot, ["add", "-A", "--", "."], { env: gitEnv });
      return (await runGit(session.repoRoot, ["write-tree"], { env: gitEnv })).stdout.trim();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async assertTargetWorkspaceClean(session: CompanionSession, targetHead: string): Promise<void> {
    const targetTree = await this.resolveCommitTree(session.repoRoot, targetHead);
    const currentTargetTree = await this.captureTargetWorktreeTree(session);
    if (targetTree && currentTargetTree && targetTree !== currentTargetTree) {
      throw new Error("target workspace に未反映の変更があります。commit または stash してから Sync Target してください。");
    }
  }

  private async resolveTreeDiffPaths(repoRoot: string, baseTree: string, targetTree: string): Promise<ChangedPath[]> {
    const diffOutput = (await runGit(repoRoot, ["diff-tree", "--name-status", "-z", "-r", baseTree, targetTree])).stdout;
    return parseNameStatusZ(diffOutput);
  }

  private async createBaseSnapshotFromTarget(session: CompanionSession, targetHead: string): Promise<string> {
    const targetTree = await this.resolveCommitTree(session.repoRoot, targetHead);
    if (!targetTree) {
      throw new Error("target HEAD の tree を解決できません。");
    }
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "WithMate",
      GIT_AUTHOR_EMAIL: "withmate@example.invalid",
      GIT_COMMITTER_NAME: "WithMate",
      GIT_COMMITTER_EMAIL: "withmate@example.invalid",
    };
    return (await runGit(
      session.repoRoot,
      [
        "commit-tree",
        targetTree,
        "-p",
        targetHead,
        "-m",
        `WithMate companion sync snapshot\n\nSession: ${session.id}`,
      ],
      { env: gitEnv },
    )).stdout.trim();
  }

  private async createCompanionPatch(session: CompanionSession): Promise<string> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-sync-index-"));
    const tempIndexPath = path.join(tempDirectory, "index");
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
    };
    const worktreeGitEnv = {
      ...gitEnv,
      GIT_WORK_TREE: session.worktreePath,
    };

    try {
      await runGit(session.repoRoot, ["read-tree", session.baseSnapshotCommit], { env: gitEnv });
      await runGit(session.repoRoot, ["add", "-A", "--", "."], { env: worktreeGitEnv });
      const companionTree = (await runGit(session.repoRoot, ["write-tree"], { env: gitEnv })).stdout.trim();
      return (await runGit(
        session.repoRoot,
        ["diff-tree", "--binary", "--full-index", "-p", session.baseSnapshotCommit, companionTree],
      )).stdout;
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async checkPatchApplies(session: CompanionSession, baseSnapshotCommit: string, patchPath: string): Promise<void> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-sync-check-"));
    const checkWorktreePath = path.join(tempDirectory, "worktree");

    try {
      await runGit(session.repoRoot, ["worktree", "add", "--detach", checkWorktreePath, baseSnapshotCommit]);
      await runGit(checkWorktreePath, ["apply", "--3way", "--whitespace=nowarn", patchPath]);
      const status = (await runGit(checkWorktreePath, ["status", "--porcelain=v1", "-z"])).stdout;
      if (status.includes("\0U") || status.startsWith("U") || status.includes("\0AA ") || status.includes("\0DD ")) {
        throw new Error("patch leaves unmerged paths");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "patch apply check failed";
      throw new Error(`Sync Target conflict: ${message}`);
    } finally {
      await runGit(session.repoRoot, ["worktree", "remove", "--force", checkWorktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async simulateSelectedFilesMerge(session: CompanionSession, selectedPaths: string[]): Promise<void> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-merge-index-"));
    const tempIndexPath = path.join(tempDirectory, "index");
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
    };
    const worktreeGitEnv = {
      ...gitEnv,
      GIT_WORK_TREE: session.worktreePath,
    };
    const changedPaths = await this.resolveChangedPaths(session);
    const changedPathByPath = new Map(changedPaths.map((change) => [change.path, change]));

    try {
      await runGit(session.repoRoot, ["read-tree", session.baseSnapshotCommit], { env: gitEnv });
      for (const selectedPath of selectedPaths) {
        const change = changedPathByPath.get(selectedPath);
        if (!change) {
          throw new Error(`changed files にない file は merge できません: ${selectedPath}`);
        }
        if (change.kind === "delete") {
          await runGit(session.repoRoot, ["update-index", "--force-remove", "--", selectedPath], { env: gitEnv });
        } else {
          await runGit(session.repoRoot, ["add", "--", selectedPath], { env: worktreeGitEnv });
        }
      }
      await runGit(session.repoRoot, ["write-tree"], { env: gitEnv });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async buildChangedFile(session: CompanionSession, change: ChangedPath): Promise<ChangedFile> {
    const beforeContent = change.kind === "add"
      ? null
      : await readGitFile(session.repoRoot, session.baseSnapshotCommit, change.path);
    const afterContent = change.kind === "delete"
      ? null
      : await readWorktreeFile(session.worktreePath, change.path);

    return {
      kind: change.kind,
      path: change.path,
      summary: summarizeChangedFile(change.kind, change.path),
      diffRows: buildDiffRows(beforeContent, afterContent),
    };
  }

  private async applySelectedChange(session: CompanionSession, change: ChangedPath): Promise<void> {
    const targetPath = path.join(session.repoRoot, change.path);
    if (change.kind === "delete") {
      await rm(targetPath, { force: true });
      return;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(path.join(session.worktreePath, change.path), targetPath);
  }
}
