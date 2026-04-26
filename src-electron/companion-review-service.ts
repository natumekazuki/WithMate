import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ChangedFile } from "../src/runtime-state.js";
import type { CompanionReviewSnapshot } from "../src/companion-review-state.js";
import type { CompanionSession } from "../src/companion-state.js";
import { currentTimestampLabel } from "../src/time-state.js";
import { cleanupCompanionWorkspaceArtifacts } from "./companion-git.js";
import { buildDiffRows, summarizeChangedFile } from "./provider-artifact.js";

const execFileAsync = promisify(execFile);

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

type ChangedPath = {
  path: string;
  kind: ChangedFile["kind"];
};

export type CompanionReviewServiceDeps = {
  getCompanionSession(sessionId: string): CompanionSession | null;
  updateCompanionSession(session: CompanionSession): CompanionSession;
};

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
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

async function runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
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

async function readGitFileBuffer(repoRoot: string, ref: string, filePath: string): Promise<Buffer | null> {
  try {
    return await runGitBuffer(repoRoot, ["show", `${ref}:${filePath}`]);
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

async function readWorktreeFileBuffer(worktreePath: string, filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(worktreePath, filePath));
  } catch {
    return null;
  }
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.equals(right);
}

export class CompanionReviewService {
  constructor(private readonly deps: CompanionReviewServiceDeps) {}

  async getReviewSnapshot(sessionId: string): Promise<CompanionReviewSnapshot | null> {
    const session = this.deps.getCompanionSession(sessionId);
    if (!session) {
      return null;
    }

    const changedPaths = await this.resolveChangedPaths(session);
    const changedFiles = await Promise.all(changedPaths.map((change) => this.buildChangedFile(session, change)));

    return {
      session,
      changedFiles,
      generatedAt: currentTimestampLabel(),
      warnings: [],
    };
  }

  async mergeSelectedFiles(sessionId: string, selectedPaths: string[]): Promise<CompanionSession> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中なので merge できないよ。");
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
        throw new Error(`changed files にない file は merge できないよ: ${filePath}`);
      }
      return change;
    });

    await Promise.all(selectedChanges.map((change) => this.assertTargetPathMatchesBase(session, change.path)));
    for (const change of selectedChanges) {
      await this.applySelectedChange(session, change);
    }

    await cleanupCompanionWorkspaceArtifacts({
      repoRoot: session.repoRoot,
      baseSnapshotRef: session.baseSnapshotRef,
      baseSnapshotCommit: session.baseSnapshotCommit,
      companionBranch: session.companionBranch,
      worktreePath: session.worktreePath,
    });

    return this.deps.updateCompanionSession({
      ...session,
      status: "merged",
      runState: "idle",
      updatedAt: currentTimestampLabel(),
    });
  }

  async discardSession(sessionId: string): Promise<CompanionSession> {
    const session = this.requireActiveSession(sessionId);
    if (session.runState === "running") {
      throw new Error("Companion が実行中なので discard できないよ。");
    }

    await cleanupCompanionWorkspaceArtifacts({
      repoRoot: session.repoRoot,
      baseSnapshotRef: session.baseSnapshotRef,
      baseSnapshotCommit: session.baseSnapshotCommit,
      companionBranch: session.companionBranch,
      worktreePath: session.worktreePath,
    });

    return this.deps.updateCompanionSession({
      ...session,
      status: "discarded",
      runState: "idle",
      updatedAt: currentTimestampLabel(),
    });
  }

  private requireActiveSession(sessionId: string): CompanionSession {
    const session = this.deps.getCompanionSession(sessionId);
    if (!session) {
      throw new Error("対象 CompanionSession が見つからないよ。");
    }
    if (session.status !== "active") {
      throw new Error("active ではない CompanionSession は操作できないよ。");
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

  private async assertTargetPathMatchesBase(session: CompanionSession, filePath: string): Promise<void> {
    const baseContent = await readGitFileBuffer(session.repoRoot, session.baseSnapshotCommit, filePath);
    const targetContent = await readWorktreeFileBuffer(session.repoRoot, filePath);
    if (!buffersEqual(baseContent, targetContent)) {
      throw new Error(`target workspace 側で base から変更されているため merge できないよ: ${filePath}`);
    }
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
