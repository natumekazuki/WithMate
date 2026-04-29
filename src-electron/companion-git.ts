import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CompanionGitEligibility =
  | {
      ok: true;
      repoRoot: string;
      focusPath: string;
      targetBranch: string;
      warnings: string[];
    }
  | {
      ok: false;
      reason: string;
      warnings: string[];
    };

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

type GitCommandOptions = {
  env?: NodeJS.ProcessEnv;
};

export type CreateCompanionWorkspaceInput = {
  repoRoot: string;
  sessionId: string;
  safeSessionId: string;
  companionBranch: string;
  worktreePath: string;
};

export type CompanionWorkspaceArtifacts = {
  repoRoot: string;
  baseSnapshotRef: string;
  baseSnapshotCommit: string;
  companionBranch: string;
  worktreePath: string;
};

async function runGit(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", ["-c", "core.longpaths=true", "-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: options.env,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const candidate = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message || "git command failed");
  }
}

async function gitRefExists(repoRoot: string, refName: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["show-ref", "--verify", "--quiet", refName]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toDisplayName(repoRoot: string): string {
  return path.basename(repoRoot.replace(/[\\/]+$/, "")) || repoRoot;
}

export async function resolveCompanionGitEligibility(workspacePath: string): Promise<CompanionGitEligibility> {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) {
    return { ok: false, reason: "workspace path が空だよ。", warnings: [] };
  }

  const warnings: string[] = [];
  let repoRoot = "";
  try {
    repoRoot = (await runGit(normalizedWorkspacePath, ["rev-parse", "--show-toplevel"])).stdout;
  } catch {
    return { ok: false, reason: "Git repo root を解決できないよ。", warnings };
  }

  try {
    const bare = (await runGit(repoRoot, ["rev-parse", "--is-bare-repository"])).stdout;
    if (bare === "true") {
      return { ok: false, reason: "bare repo では Companion を開始できないよ。", warnings };
    }
  } catch {
    return { ok: false, reason: "Git repo の状態確認に失敗したよ。", warnings };
  }

  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return { ok: false, reason: "HEAD がない repo では Companion を開始できないよ。", warnings };
  }

  let targetBranch = "";
  try {
    targetBranch = (await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout;
  } catch {
    return { ok: false, reason: "detached HEAD では target branch を決められないよ。", warnings };
  }

  try {
    const submoduleStatus = (await runGit(repoRoot, ["submodule", "status", "--recursive"])).stdout;
    if (/^[+-U]/m.test(submoduleStatus)) {
      warnings.push("submodule dirty の可能性があるよ。");
    }
  } catch {
    warnings.push("submodule 状態を確認できなかったよ。");
  }

  const relativeFocusPath = path.relative(repoRoot, normalizedWorkspacePath);
  const focusPath =
    relativeFocusPath && !relativeFocusPath.startsWith("..") && !path.isAbsolute(relativeFocusPath)
      ? relativeFocusPath
      : "";

  return {
    ok: true,
    repoRoot,
    focusPath,
    targetBranch,
    warnings,
  };
}

export function buildCompanionGroupDisplayName(repoRoot: string): string {
  return toDisplayName(repoRoot);
}

export function buildCompanionBaseSnapshotRef(safeSessionId: string): string {
  return `refs/withmate/companion/${safeSessionId}/base`;
}

export async function createCompanionWorkspace(
  input: CreateCompanionWorkspaceInput,
): Promise<CompanionWorkspaceArtifacts> {
  const baseSnapshotRef = buildCompanionBaseSnapshotRef(input.safeSessionId);
  const createdArtifacts = {
    snapshotRef: false,
    branch: false,
    worktree: false,
  };

  if (await gitRefExists(input.repoRoot, baseSnapshotRef)) {
    throw new Error("Companion snapshot ref が既に存在するよ。");
  }
  if (await gitRefExists(input.repoRoot, `refs/heads/${input.companionBranch}`)) {
    throw new Error("Companion branch が既に存在するよ。");
  }
  if (await pathExists(input.worktreePath)) {
    throw new Error("Companion worktree path が既に存在するよ。");
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), `withmate-companion-index-${input.safeSessionId}-`));
  const tempIndexPath = path.join(tempDirectory, "index");
  const gitEnv = {
    ...process.env,
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: "WithMate",
    GIT_AUTHOR_EMAIL: "withmate@example.invalid",
    GIT_COMMITTER_NAME: "WithMate",
    GIT_COMMITTER_EMAIL: "withmate@example.invalid",
  };

  try {
    const headCommit = (await runGit(input.repoRoot, ["rev-parse", "HEAD"])).stdout;
    await runGit(input.repoRoot, ["read-tree", "HEAD"], { env: gitEnv });
    await runGit(input.repoRoot, ["add", "-A", "--", "."], { env: gitEnv });
    const tree = (await runGit(input.repoRoot, ["write-tree"], { env: gitEnv })).stdout;
    const baseSnapshotCommit = (await runGit(
      input.repoRoot,
      [
        "commit-tree",
        tree,
        "-p",
        headCommit,
        "-m",
        `WithMate companion snapshot\n\nSession: ${input.sessionId}`,
      ],
      { env: gitEnv },
    )).stdout;

    await runGit(input.repoRoot, ["update-ref", baseSnapshotRef, baseSnapshotCommit]);
    createdArtifacts.snapshotRef = true;
    await runGit(input.repoRoot, ["branch", input.companionBranch, baseSnapshotCommit]);
    createdArtifacts.branch = true;
    await mkdir(path.dirname(input.worktreePath), { recursive: true });
    await runGit(input.repoRoot, ["worktree", "add", input.worktreePath, input.companionBranch]);
    createdArtifacts.worktree = true;

    return {
      repoRoot: input.repoRoot,
      baseSnapshotRef,
      baseSnapshotCommit,
      companionBranch: input.companionBranch,
      worktreePath: input.worktreePath,
    };
  } catch (error) {
    if (createdArtifacts.worktree) {
      await runGit(input.repoRoot, ["worktree", "remove", "--force", input.worktreePath]).catch(() => undefined);
    } else {
      await runGit(input.repoRoot, ["worktree", "remove", "--force", input.worktreePath]).catch(() => undefined);
      await rm(input.worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (createdArtifacts.branch) {
      await runGit(input.repoRoot, ["branch", "-D", input.companionBranch]).catch(() => undefined);
    }
    if (createdArtifacts.snapshotRef) {
      await runGit(input.repoRoot, ["update-ref", "-d", baseSnapshotRef]).catch(() => undefined);
    }

    throw error;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function cleanupCompanionWorkspaceArtifacts(artifacts: CompanionWorkspaceArtifacts): Promise<void> {
  await runGit(artifacts.repoRoot, ["worktree", "remove", "--force", artifacts.worktreePath]).catch(() => undefined);
  await runGit(artifacts.repoRoot, ["branch", "-D", artifacts.companionBranch]).catch(() => undefined);
  await runGit(artifacts.repoRoot, ["update-ref", "-d", artifacts.baseSnapshotRef]).catch(() => undefined);
}
