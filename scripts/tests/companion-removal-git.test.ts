import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { removeCompanionGitAssets } from "../../src-electron/companion-removal-git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-removal-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  return root;
}

// @test-value v2
// kind = "invariant"
// claim = "退役済みCompanion専有worktree・branch・base refだけを物理削除し、target branch・他worktree・stashを保全する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "専用Git資産を残す、または通常branch・workspace・stashを巻き込んで削除する"
// observable = "worktree list、ref解決結果、stash list、通常workspaceの内容"
// observation_boundary = "public-boundary"
// scope = "companion-removal-git"
// lifecycle = "permanent"
// impact = "誤削除による通常作業・target branch・一般stashのデータ損失を防ぐ"
// distinction = "build/typecheckでは確認できないGit登録と未コミット変更の削除境界を実Gitで確認する"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
test("removes owned assets while preserving target branch, other worktree, and stash", async (t) => {
  const root = await fixture();
  t.after(async () => {
    await git(root, "worktree", "remove", "--force", path.join(root, "userdata", "other-worktree")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const base = await git(root, "rev-parse", "HEAD");
  const sessionId = "companion-session-729";
  const branch = "withmate/companion/companion-session-729";
  const userDataPath = path.join(root, "userdata");
  const worktree = path.join(userDataPath, "cw", "cs-729");
  const otherWorktree = path.join(userDataPath, "other-worktree");
  const ref = "refs/withmate/companion/companion-session-729/base";
  await mkdir(userDataPath, { recursive: true });
  await git(root, "worktree", "add", "--detach", otherWorktree, "main");
  await git(root, "update-ref", ref, base);
  await git(root, "branch", branch, base);
  await git(root, "worktree", "add", worktree, branch);
  await writeFile(path.join(worktree, "uncommitted.txt"), "discard me\n");
  await git(worktree, "add", "uncommitted.txt");
  await git(worktree, "commit", "-m", "unmerged companion change");
  await writeFile(path.join(root, "target.txt"), "keep me\n");
  await git(root, "stash", "push", "-u", "-m", `WithMate Target Changes session=${sessionId} stash=owned`);
  await writeFile(path.join(root, "user.txt"), "keep user stash\n");
  await git(root, "stash", "push", "-u", "-m", "user stash");

  const result = await removeCompanionGitAssets({
    sessionId,
    userDataPath,
    repoRoot: root,
    targetBranch: "main",
    baseSnapshotRef: ref,
    baseSnapshotCommit: base,
    companionBranch: branch,
    worktreePath: worktree,
  });
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchRemoved, true);
  assert.equal(result.baseSnapshotRefRemoved, true);
  assert.equal(result.stashesRemoved, 0);
  assert.equal(await git(root, "rev-parse", "refs/heads/main"), base);
  assert.equal(existsSync(worktree), false);
  assert.equal(await git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`, ref), "");
  assert.equal((await git(root, "worktree", "list", "--porcelain")).replaceAll("\\", "/").includes(worktree.replaceAll("\\", "/")), false);
  assert.equal((await git(root, "stash", "list")).includes("user stash"), true);
  assert.equal((await git(root, "stash", "list")).includes(`session=${sessionId}`), true);
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await readFile(path.join(otherWorktree, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "base\n");
  assert.equal(await readFile(path.join(root, "target.txt"), "utf8").catch(() => ""), "");

  const rerun = await removeCompanionGitAssets({
    sessionId,
    userDataPath,
    repoRoot: root,
    targetBranch: "main",
    baseSnapshotRef: ref,
    baseSnapshotCommit: base,
    companionBranch: branch,
    worktreePath: worktree,
  });
  assert.deepEqual(rerun, { worktreeRemoved: false, branchRemoved: false, baseSnapshotRefRemoved: false, stashesRemoved: 0 });
});

// @test-value v2
// kind = "invariant"
// claim = "退役済みCompanionの専用pathはGit未登録でも削除し、target branchを保持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "専用pathのGit未登録を理由に撤去を停止する、またはtarget branchを削除する"
// observable = "専用directoryの不在とtarget branchのOID"
// observation_boundary = "public-boundary"
// scope = "companion-removal-git"
// lifecycle = "permanent"
// impact = "退役済み専用資産の残留による起動停止と、無関係な資産の誤削除を防ぐ"
// distinction = "Git登録を失ったdirectoryの撤去と通常branchの保全を実filesystem/Gitで検証する"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
test("removes an unregistered dedicated path without Git registration", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "userdata");
  const worktree = path.join(userDataPath, "cw", "cs-729");
  await mkdir(userDataPath, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, "retired.txt"), "retired\n");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "update-ref", "refs/withmate/companion/companion-session-729/base", base);
  const result = await removeCompanionGitAssets({
    sessionId: "companion-session-729",
    userDataPath,
    repoRoot: root,
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/companion-session-729/base",
    baseSnapshotCommit: base,
    companionBranch: "withmate/companion/companion-session-729",
    worktreePath: worktree,
  });
  assert.equal(result.worktreeRemoved, true);
  assert.equal(existsSync(worktree), false);
  assert.equal(await git(root, "rev-parse", "--verify", "refs/heads/main"), base);
});

// @test-value v2
// kind = "security"
// claim = "共有先へのlinkを削除せず、旧repoが不在または通常directoryになっていても専用folderを撤去する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "symlinkを辿って共有先を削除する、または旧repoのGit情報消失で撤去を停止する"
// observable = "symlink rejection、共有先の本文保持、Gitがない旧repoに紐づく専用folderの不在"
// observation_boundary = "public-boundary"
// scope = "Retired Companion Git removal boundary"
// lifecycle = "permanent"
// @end-test-value
test("rejects symlinks and tolerates a missing repo", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, "rev-parse", "HEAD");
  const sessionId = "companion-session-safety";
  const userDataPath = path.join(root, "userdata");
  await mkdir(userDataPath, { recursive: true });
  const branch = "withmate/companion/companion-session-safety";
  const ref = "refs/withmate/companion/companion-session-safety/base";
  await git(root, "update-ref", ref, base);
  await git(root, "branch", branch, base);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "shared content");
  const cw = path.join(userDataPath, "cw");
  await mkdir(cw, { recursive: true });
  await symlink(outside, path.join(cw, "cs-safety"), "junction");
  await assert.rejects(removeCompanionGitAssets({
    sessionId, userDataPath, repoRoot: root, targetBranch: "main", baseSnapshotRef: ref,
    baseSnapshotCommit: base, companionBranch: branch, worktreePath: path.join(cw, "cs-safety"),
  }), /symlink|旧命名/);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "shared content");
  await rm(cw, { recursive: true, force: true });

  const wrongBranch = path.join(userDataPath, "cw", "cs-safety");
  await mkdir(path.dirname(wrongBranch), { recursive: true });
  const result = await removeCompanionGitAssets({
    sessionId, userDataPath, repoRoot: root, targetBranch: "main", baseSnapshotRef: ref,
    baseSnapshotCommit: base, companionBranch: branch, worktreePath: wrongBranch,
  });
  assert.equal(result.branchRemoved, true);
  assert.equal(result.baseSnapshotRefRemoved, true);
  // `outside` is an ordinary directory inside another Git repository. Cleanup
  // must not discover that ancestor's refs when the old repo itself is gone.
  const unrelatedRef = "refs/heads/keep-retired-workspace";
  await git(root, "update-ref", unrelatedRef, base);
  for (const retiredRepo of [path.join(root, "missing"), outside]) {
    await mkdir(wrongBranch);
    await writeFile(path.join(wrongBranch, "retired.txt"), "retired worktree");
    const removed = await removeCompanionGitAssets({
      sessionId, userDataPath, repoRoot: retiredRepo, targetBranch: "main", baseSnapshotRef: ref,
      baseSnapshotCommit: base, companionBranch: branch, worktreePath: wrongBranch,
    });
    assert.deepEqual(removed, { worktreeRemoved: true, branchRemoved: false, baseSnapshotRefRemoved: false, stashesRemoved: 0 });
    assert.equal(existsSync(wrongBranch), false);
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "shared content");
    assert.equal(await git(root, "rev-parse", unrelatedRef), base);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Git削除の再開は保存済みOIDや祖先関係に依存せず、専用namespaceの残件だけを削除する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "過去のOID差分やbase不存在を理由に退役処理を停止する"
// observable = "replacement branchの削除と再実行の無害な完了"
// observation_boundary = "public-boundary"
// scope = "Git removal restart"
// lifecycle = "permanent"
// @end-test-value
test("restarts cleanup without requiring saved OIDs", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, "rev-parse", "HEAD");
  const sessionId = "companion-session-interrupted";
  const userDataPath = path.join(root, "userdata");
  const worktree = path.join(userDataPath, "cw", "cs-interrupted");
  const branch = "withmate/companion/companion-session-interrupted";
  const ref = "refs/withmate/companion/companion-session-interrupted/base";
  await mkdir(userDataPath, { recursive: true });
  await git(root, "update-ref", ref, base);
  await git(root, "branch", branch, base);
  await git(root, "worktree", "add", worktree, branch);
  const replacement = await git(root, "commit-tree", `${base}^{tree}`, "-m", "replacement");
  await git(root, "update-ref", `refs/heads/${branch}`, replacement);
  const result = await removeCompanionGitAssets({
    sessionId, userDataPath, repoRoot: root, targetBranch: "main", baseSnapshotRef: ref,
    baseSnapshotCommit: base, companionBranch: branch, worktreePath: worktree,
  });
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.branchRemoved, true);
  assert.equal(result.baseSnapshotRefRemoved, true);
  assert.equal(await git(root, "show-ref", "--verify", ref).then(() => true).catch(() => false), false);
  assert.equal(await git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`), "");
  assert.equal(existsSync(worktree), false);
  const rerun = await removeCompanionGitAssets({
    sessionId, userDataPath, repoRoot: root, targetBranch: "main", baseSnapshotRef: ref,
    baseSnapshotCommit: "old-commit-no-longer-present", companionBranch: branch, worktreePath: worktree,
  });
  assert.deepEqual(rerun, { worktreeRemoved: false, branchRemoved: false, baseSnapshotRefRemoved: false, stashesRemoved: 0 });
});
