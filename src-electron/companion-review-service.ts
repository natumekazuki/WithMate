import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ChangedFile } from "../src/runtime-state.js";
import type { CompanionReviewSnapshot } from "../src/companion-review-state.js";
import type { CompanionSession } from "../src/companion-state.js";
import { currentTimestampLabel } from "../src/time-state.js";
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

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
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
}
