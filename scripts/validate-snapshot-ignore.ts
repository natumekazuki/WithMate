import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { scanWorkspacePaths } from "../src-electron/snapshot-ignore.js";

const execFileAsync = promisify(execFile);

async function resolveGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
  return stdout.trim();
}

async function loadGitIgnoredPaths(gitRoot: string, rootDirectory: string, candidatePaths: string[]): Promise<Set<string>> {
  const gitRelativeCandidates = candidatePaths
    .map((relativePath) => path.relative(gitRoot, path.resolve(rootDirectory, relativePath)).replace(/\\/g, "/"))
    .filter((relativePath) => relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));

  if (gitRelativeCandidates.length === 0) {
    return new Set();
  }

  const result = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: gitRoot,
    input: gitRelativeCandidates.join("\n"),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `git check-ignore failed with status ${result.status}`);
  }
  const stdout = result.stdout ?? "";

  const ignoredFromGit = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const gitRelativePath = line.trim();
    if (!gitRelativePath) {
      continue;
    }

    const rootRelativePath = path.relative(rootDirectory, path.resolve(gitRoot, gitRelativePath)).replace(/\\/g, "/");
    if (!rootRelativePath.startsWith("..") && !path.isAbsolute(rootRelativePath)) {
      ignoredFromGit.add(rootRelativePath);
    }
  }

  return ignoredFromGit;
}

function diffSets(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

async function main(): Promise<void> {
  const rootDirectory = path.resolve(process.argv[2] ?? process.cwd());
  const scan = await scanWorkspacePaths(rootDirectory);
  const gitRoot = await resolveGitRoot(rootDirectory);
  const candidatePaths = [...scan.includedFiles, ...scan.ignoredFiles];
  const snapshotIgnored = new Set(scan.ignoredFiles);
  const gitIgnored = await loadGitIgnoredPaths(gitRoot, rootDirectory, candidatePaths);

  const onlySnapshotIgnored = diffSets(snapshotIgnored, gitIgnored);
  const onlyGitIgnored = diffSets(gitIgnored, snapshotIgnored);

  console.log(`root: ${rootDirectory}`);
  console.log(`gitRoot: ${gitRoot}`);
  console.log(`snapshotIgnored: ${snapshotIgnored.size}`);
  console.log(`gitIgnored: ${gitIgnored.size}`);

  if (onlySnapshotIgnored.length === 0 && onlyGitIgnored.length === 0) {
    console.log("snapshot ignore は git check-ignore と一致したよ。");
    return;
  }

  if (onlySnapshotIgnored.length > 0) {
    console.log("snapshot だけが無視している path:");
    for (const entry of onlySnapshotIgnored.slice(0, 50)) {
      console.log(`  ${entry}`);
    }
  }

  if (onlyGitIgnored.length > 0) {
    console.log("git だけが無視している path:");
    for (const entry of onlyGitIgnored.slice(0, 50)) {
      console.log(`  ${entry}`);
    }
  }

  process.exitCode = 1;
}

await main();
