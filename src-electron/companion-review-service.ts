import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  CompanionTargetWorkspaceStash,
  CompanionTargetWorkspaceStashResult,
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
  deleteCompanionSession?(sessionId: string): void;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function hasUnmergedStatus(status: string): boolean {
  return status.includes("\0U") || status.startsWith("U") || status.includes("\0AA ") || status.includes("\0DD ");
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
      targetStash: await this.resolveTargetWorkspaceStash(session),
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
      targetStash: null,
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
    if (await this.resolveTargetWorkspaceStash(session)) {
      throw new Error("WithMate が退避した target stash が残っています。Restore Stash または Drop Stash してから merge してください。");
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

    await this.applySelectedChangesWithGit(session, selectedChanges);
    const siblingWarnings = await this.checkSiblingImpact(session, selectedChanges);

    await cleanupCompanionWorkspaceArtifacts({
      repoRoot: session.repoRoot,
      baseSnapshotRef: session.baseSnapshotRef,
      baseSnapshotCommit: session.baseSnapshotCommit,
      companionBranch: session.companionBranch,
      worktreePath: session.worktreePath,
    });

    const completedAt = currentTimestampLabel();
    const mergedSession: CompanionSession = {
      ...session,
      status: "merged",
      selectedPaths: normalizedSelectedPaths,
      changedFiles: changedPaths,
      siblingWarnings,
      runState: "idle",
      updatedAt: completedAt,
    };
    if (this.deps.deleteCompanionSession) {
      this.deps.deleteCompanionSession(session.id);
      return {
        session: mergedSession,
        siblingWarnings,
      };
    }

    const storedSession = this.deps.updateCompanionSession(mergedSession);
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
    const discardedSession: CompanionSession = {
      ...session,
      status: "discarded",
      selectedPaths: [],
      changedFiles: changedPaths,
      siblingWarnings: [],
      runState: "idle",
      updatedAt: completedAt,
    };
    if (this.deps.deleteCompanionSession) {
      this.deps.deleteCompanionSession(session.id);
      return discardedSession;
    }

    const storedSession = this.deps.updateCompanionSession(discardedSession);
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
    await this.assertTargetWorkspaceClean(session, targetHead);
    if (baseParent === targetHead && await this.isBaseSnapshotSyncedToTarget(session, targetHead)) {
      return { session };
    }
    if (!(await this.isAncestor(session.repoRoot, baseParent, targetHead))) {
      throw new Error("target branch の履歴が base snapshot から分岐しています。Companion の再作成を検討してください。");
    }

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

  async stashTargetChanges(sessionId: string): Promise<CompanionTargetWorkspaceStashResult> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中のため target changes を stash できません。");
    }

    const status = (await runGit(session.repoRoot, ["status", "--porcelain=v1", "-z"])).stdout;
    if (status.length === 0) {
      return { stash: await this.resolveTargetWorkspaceStash(session) };
    }

    await runGit(session.repoRoot, [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      this.buildTargetWorkspaceStashMessage(session, randomUUID()),
    ]);
    return { stash: await this.requireTargetWorkspaceStash(session) };
  }

  async restoreTargetChanges(sessionId: string): Promise<CompanionTargetWorkspaceStashResult> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中のため target stash を戻せません。");
    }

    const stash = await this.requireTargetWorkspaceStash(session);
    const status = (await runGit(session.repoRoot, ["status", "--porcelain=v1", "-z"])).stdout;
    if (status.length > 0) {
      throw new Error("target workspace に変更があります。stash を戻す前に commit または stash してください。");
    }

    try {
      await runGit(session.repoRoot, ["stash", "apply", "--index", stash.ref]);
      await runGit(session.repoRoot, ["stash", "drop", stash.ref]);
    } catch (error) {
      throw new Error(`target stash を戻せませんでした。stash は残しています: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { stash: await this.resolveTargetWorkspaceStash(session) };
  }

  async dropTargetStash(sessionId: string): Promise<CompanionTargetWorkspaceStashResult> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中のため target stash を破棄できません。");
    }

    const stash = await this.requireTargetWorkspaceStash(session);
    await runGit(session.repoRoot, ["stash", "drop", stash.ref]);
    return { stash: await this.resolveTargetWorkspaceStash(session) };
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
    } else if (targetHead && !(await this.isBaseSnapshotSyncedToTarget(session, targetHead))) {
      blockers.push({
        kind: "target-branch-drift",
        message: "base snapshot が target branch の HEAD と一致していないため merge できません。",
      });
    }

    const targetTree = await this.captureTargetWorktreeTree(session);
    const targetHeadTree = targetHead ? await this.resolveCommitTree(session.repoRoot, targetHead) : "";
    if (targetTree && targetHeadTree && targetTree !== targetHeadTree) {
      const dirtyPaths = await this.resolveTreeDiffPaths(session.repoRoot, targetHeadTree, targetTree);
      blockers.push({
        kind: "target-worktree-dirty",
        message: "target workspace が target branch の HEAD から変わっているため merge できません。",
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

  private async isBaseSnapshotSyncedToTarget(session: CompanionSession, targetHead: string): Promise<boolean> {
    const baseTree = await this.resolveCommitTree(session.repoRoot, session.baseSnapshotCommit);
    const targetTree = await this.resolveCommitTree(session.repoRoot, targetHead);
    return Boolean(baseTree && targetTree && baseTree === targetTree);
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
      throw new Error("target workspace が target branch の HEAD と一致していません。target branch を checkout してから Sync Target してください。");
    }
  }

  private buildTargetWorkspaceStashMessage(session: CompanionSession, stashId: string): string {
    return `WithMate Target Changes session=${session.id} stash=${stashId}`;
  }

  private async resolveTargetWorkspaceStash(session: CompanionSession): Promise<CompanionTargetWorkspaceStash | null> {
    const output = (await runGit(session.repoRoot, ["stash", "list", "--format=%gd%x1f%H%x1f%s"])).stdout;
    const currentStashPattern = new RegExp(`WithMate Target Changes session=${escapeRegExp(session.id)} stash=([^\\s]+)`);
    const legacyStashMessage = `WithMate Target Changes ${session.id}`;
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const [ref, hash, message] = line.split("\x1f");
      const currentMatch = message?.match(currentStashPattern);
      if (ref && hash && message && currentMatch?.[1]) {
        return { id: currentMatch[1], ref, hash, message };
      }
      if (ref && hash && message?.includes(legacyStashMessage)) {
        return { id: hash, ref, hash, message };
      }
    }
    return null;
  }

  private async requireTargetWorkspaceStash(session: CompanionSession): Promise<CompanionTargetWorkspaceStash> {
    const stash = await this.resolveTargetWorkspaceStash(session);
    if (!stash) {
      throw new Error("WithMate が退避した target stash が見つかりません。");
    }
    return stash;
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
      if (hasUnmergedStatus(status)) {
        throw new Error("patch leaves unmerged paths");
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("patch apply check failed");
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
        await this.applyChangeToIndex(session, change, gitEnv, worktreeGitEnv);
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

  private async applyChangeToIndex(
    session: CompanionSession,
    change: ChangedPath,
    gitEnv: NodeJS.ProcessEnv,
    worktreeGitEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    if (change.kind === "delete") {
      await runGit(session.repoRoot, ["update-index", "--force-remove", "--", change.path], { env: gitEnv });
      return;
    }

    await runGit(session.repoRoot, ["add", "--", change.path], { env: worktreeGitEnv });
  }

  private async createSelectedChangesPatch(session: CompanionSession, selectedChanges: ChangedPath[]): Promise<string> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-selected-patch-"));
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
      for (const change of selectedChanges) {
        await this.applyChangeToIndex(session, change, gitEnv, worktreeGitEnv);
      }
      const selectedTree = (await runGit(session.repoRoot, ["write-tree"], { env: gitEnv })).stdout.trim();
      return (await runGit(
        session.repoRoot,
        [
          "diff-tree",
          "--binary",
          "--full-index",
          "-p",
          session.baseSnapshotCommit,
          selectedTree,
          "--",
          ...selectedChanges.map((change) => change.path),
        ],
      )).stdout;
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async applySelectedChangesWithGit(session: CompanionSession, selectedChanges: ChangedPath[]): Promise<void> {
    const patchText = await this.createSelectedChangesPatch(session, selectedChanges);
    if (patchText.trim().length === 0) {
      return;
    }

    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-selected-apply-"));
    const patchPath = path.join(tempDirectory, "selected.patch");
    const targetHead = await this.resolveTargetHead(session);
    try {
      await writeFile(patchPath, patchText, "utf8");
      if (!targetHead) {
        throw new Error("target branch を解決できません。");
      }
      await this.assertTargetWorkspaceClean(session, targetHead);
      await this.assertBaseSnapshotMatchesTarget(session, targetHead);
      await this.checkSelectedPatchApplies(session, targetHead, patchPath);
      try {
        await runGit(session.repoRoot, ["apply", "--check", "--whitespace=nowarn", patchPath]);
        await runGit(session.repoRoot, ["apply", "--whitespace=nowarn", patchPath]);
      } catch (error) {
        await runGit(session.repoRoot, ["reset", "--hard", "HEAD"]).catch(() => undefined);
        await runGit(session.repoRoot, ["clean", "-fd"]).catch(() => undefined);
        throw error;
      }
      const status = (await runGit(session.repoRoot, ["status", "--porcelain=v1", "-z"])).stdout;
      if (hasUnmergedStatus(status)) {
        await runGit(session.repoRoot, ["reset", "--hard", "HEAD"]).catch(() => undefined);
        await runGit(session.repoRoot, ["clean", "-fd"]).catch(() => undefined);
        throw new Error("selected patch leaves unmerged paths");
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async checkSelectedPatchApplies(session: CompanionSession, targetHead: string, patchPath: string): Promise<void> {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-selected-check-"));
    const checkWorktreePath = path.join(tempDirectory, "worktree");

    try {
      await runGit(session.repoRoot, ["worktree", "add", "--detach", checkWorktreePath, targetHead]);
      await runGit(checkWorktreePath, ["apply", "--check", "--whitespace=nowarn", patchPath]);
      const status = (await runGit(checkWorktreePath, ["status", "--porcelain=v1", "-z"])).stdout;
      if (hasUnmergedStatus(status)) {
        throw new Error("selected patch leaves unmerged paths");
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("selected patch apply check failed");
    } finally {
      await runGit(session.repoRoot, ["worktree", "remove", "--force", checkWorktreePath]).catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async assertBaseSnapshotMatchesTarget(session: CompanionSession, targetHead: string): Promise<void> {
    const baseTree = await this.resolveCommitTree(session.repoRoot, session.baseSnapshotCommit);
    const targetTree = await this.resolveCommitTree(session.repoRoot, targetHead);
    if (baseTree && targetTree && baseTree !== targetTree) {
      throw new Error("base snapshot が target branch の HEAD と一致していません。Sync Target してください。");
    }
  }
}
