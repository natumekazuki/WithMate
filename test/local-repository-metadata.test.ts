import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveLocalRepositoryMetadata } from "../src/main/local-repository-metadata.js";
import { LOCAL_REPOSITORY_KEY_PREFIX } from "../src/shared/session-metadata.js";

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;

test("a non-Git Workspace does not produce Repository metadata", async () => {
  await withTempDirectory(async (directory) => {
    const resolution = await resolveLocalRepositoryMetadata(directory, new AbortController().signal);

    assert.equal(resolution.status, gitAvailable ? "not_git" : "unavailable");
  });
});

test("inherited Git Repository context cannot redirect Workspace detection", { skip: !gitAvailable }, async () => {
  await withTempDirectory(async (directory) => {
    const repository = path.join(directory, "repository-context");
    const nonGitWorkspace = path.join(directory, "non-git-workspace");
    fs.mkdirSync(repository);
    fs.mkdirSync(nonGitWorkspace);
    git(["init", "--quiet"], repository);

    await withEnvironment(
      {
        GIT_COMMON_DIR: path.join(repository, ".git"),
        GIT_DIR: path.join(repository, ".git"),
        GIT_WORK_TREE: repository,
      },
      async () => {
        const resolution = await resolveLocalRepositoryMetadata(nonGitWorkspace, new AbortController().signal);

        assert.deepEqual(resolution, { status: "not_git" });
      },
    );
  });
});

test(
  "linked worktrees share a local Repository key while a separate clone does not",
  { skip: !gitAvailable },
  async () => {
    await withTempDirectory(async (directory) => {
      const repository = path.join(directory, "source");
      const linkedWorktree = path.join(directory, "linked-worktree");
      const clone = path.join(directory, "clone");
      fs.mkdirSync(repository);
      git(["init", "--quiet"], repository);
      git(
        [
          "-c",
          "user.name=WithMate Test",
          "-c",
          "user.email=withmate@example.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "initial",
        ],
        repository,
      );
      git(["worktree", "add", "--quiet", "-b", "metadata-linked", linkedWorktree], repository);
      git(["clone", "--quiet", repository, clone], directory);

      const sourceResolution = await resolveLocalRepositoryMetadata(repository, new AbortController().signal);
      const linkedResolution = await resolveLocalRepositoryMetadata(linkedWorktree, new AbortController().signal);
      const cloneResolution = await resolveLocalRepositoryMetadata(clone, new AbortController().signal);

      assert.equal(sourceResolution.status, "found");
      assert.equal(linkedResolution.status, "found");
      assert.equal(cloneResolution.status, "found");
      if (
        sourceResolution.status !== "found" ||
        linkedResolution.status !== "found" ||
        cloneResolution.status !== "found"
      ) {
        assert.fail("Git Repository metadata was not resolved");
      }
      assert.match(
        sourceResolution.metadata.localRepositoryKey,
        new RegExp(`^${LOCAL_REPOSITORY_KEY_PREFIX}[0-9a-f]{64}$`, "u"),
      );
      assert.equal(linkedResolution.metadata.localRepositoryKey, sourceResolution.metadata.localRepositoryKey);
      assert.equal(linkedResolution.metadata.repositoryName, sourceResolution.metadata.repositoryName);
      assert.notEqual(cloneResolution.metadata.localRepositoryKey, sourceResolution.metadata.localRepositoryKey);
      assert.equal(sourceResolution.metadata.repositoryName, "source");
    });
  },
);

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true });
}

async function withEnvironment(values: Readonly<Record<string, string>>, run: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]] as const));
  try {
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-local-repository-"));
  try {
    await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
