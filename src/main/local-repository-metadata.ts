import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_REPOSITORY_KEY_PREFIX,
  type LocalRepositoryMetadata,
  isRepositoryName,
} from "../shared/session-metadata.js";
import { normalizeHostAbsolutePath } from "../shared/workspace-path.js";

const GIT_REPOSITORY_CONTEXT_ENVIRONMENT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);

export type LocalRepositoryMetadataResolution =
  | Readonly<{ status: "found"; metadata: Exclude<LocalRepositoryMetadata, Readonly<{ localRepositoryKey: null }>> }>
  | Readonly<{ status: "not_git" }>
  | Readonly<{ status: "unavailable" }>;

export type LocalRepositoryMetadataResolver = (
  workspacePath: string,
  signal: AbortSignal,
) => Promise<LocalRepositoryMetadataResolution>;

export const resolveLocalRepositoryMetadata: LocalRepositoryMetadataResolver = async (workspacePath, signal) => {
  const probe = await probeGitCommonDirectory(workspacePath, signal);
  if (probe.status !== "found") return probe;

  let canonicalCommonDirectory: string;
  try {
    canonicalCommonDirectory = await fs.realpath(probe.commonDirectory);
  } catch {
    return { status: "unavailable" };
  }
  const normalized = normalizeHostAbsolutePath(canonicalCommonDirectory);
  if (normalized === undefined) return { status: "unavailable" };

  const commonDirectoryName = path.basename(normalized.path);
  const repositoryName =
    commonDirectoryName.toLocaleLowerCase("en-US") === ".git"
      ? path.basename(path.dirname(normalized.path))
      : commonDirectoryName.replace(/\.git$/iu, "");
  if (!isRepositoryName(repositoryName)) return { status: "unavailable" };

  return {
    status: "found",
    metadata: {
      localRepositoryKey: `${LOCAL_REPOSITORY_KEY_PREFIX}${createHash("sha256")
        .update(normalized.comparisonKey, "utf8")
        .digest("hex")}`,
      repositoryName,
    },
  };
};

async function probeGitCommonDirectory(
  workspacePath: string,
  signal: AbortSignal,
): Promise<
  | Readonly<{ status: "found"; commonDirectory: string }>
  | Readonly<{ status: "not_git" }>
  | Readonly<{ status: "unavailable" }>
> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", workspacePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        env: gitProbeEnvironment(),
        maxBuffer: 64 * 1024,
        signal,
        timeout: 5_000,
        windowsHide: true,
      },
      async (error, stdout) => {
        if (error !== null) {
          const code = typeof error.code === "number" ? error.code : undefined;
          resolve(await classifyGitProbeFailure(workspacePath, code));
          return;
        }
        const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
        const [commonDirectory] = lines;
        resolve(
          commonDirectory !== undefined && lines.length === 1 && path.isAbsolute(commonDirectory)
            ? { status: "found", commonDirectory: path.normalize(commonDirectory) }
            : { status: "unavailable" },
        );
      },
    );
  });
}

function gitProbeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !GIT_REPOSITORY_CONTEXT_ENVIRONMENT_VARIABLES.has(name.toUpperCase()),
    ),
  );
}

async function classifyGitProbeFailure(
  workspacePath: string,
  exitCode: number | undefined,
): Promise<Readonly<{ status: "not_git" }> | Readonly<{ status: "unavailable" }>> {
  if (exitCode !== 128) return { status: "unavailable" };

  let current = path.resolve(workspacePath);
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return { status: "unavailable" };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) return { status: "unavailable" };
    }
    const parent = path.dirname(current);
    if (parent === current) return { status: "not_git" };
    current = parent;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
