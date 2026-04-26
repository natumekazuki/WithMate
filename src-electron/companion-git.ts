import { execFile } from "node:child_process";
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

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
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

