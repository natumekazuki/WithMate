import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { resolveCurrentGitBranch } from "../../src-electron/session-workspace-git.js";

const execFileAsync = promisify(execFile);

test("SESSION-PROJECTION-01: current Git branchを呼出時に解決する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-git-"));
  try {
    await execFileAsync("git", ["init", directory], { windowsHide: true });
    await execFileAsync("git", ["-C", directory, "symbolic-ref", "HEAD", "refs/heads/feature/current"], {
      windowsHide: true,
    });
    assert.equal(await resolveCurrentGitBranch(directory), "feature/current");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SESSION-PROJECTION-01: non-Git directoryはnullへ収束する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-non-git-"));
  try {
    assert.equal(await resolveCurrentGitBranch(directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
