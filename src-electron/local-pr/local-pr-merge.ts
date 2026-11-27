import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";
import {
  gitLine, gitObjectId, gitUtf8, LocalPrError, localPrGit, readLocalPrBranch, runLocalPrGit, withPreparedLocalPrRefs,
  type LocalPrRepository,
} from "./local-pr-git.js";

/** The Git worktree topology needed for HEAD locks, independent of the submitting workspace. */
type Worktree = { root: string; branch?: string; head?: string; bare: boolean };
type WorktreeTarget = Worktree & { gitDir: string };
const inProgressPaths = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"];
const checkoutArgs = ["read-tree", "-m", "-u", "--no-recurse-submodules"];

/** Reads path/branch pairs from Git without ambiguity from spaces or newlines. */
async function worktrees(root: string): Promise<Worktree[]> {
  const output = gitUtf8(await localPrGit(root, ["worktree", "list", "--porcelain", "-z"]));
  const entries: Worktree[] = [];
  // Each record begins with a worktree path and ends at an empty NUL field.
  for (const record of output.split("\0\0")) {
    if (!record) continue;
    const fields = record.split("\0");
    if (!fields[0].startsWith("worktree ")) throw new LocalPrError("GIT_FAILED", "Git returned invalid worktree metadata.");
    const branch = fields.find((field) => field.startsWith("branch "))?.slice(7);
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    entries.push({ root: fields[0].slice(9), branch, head, bare: fields.includes("bare") });
  }
  return entries;
}

/** Resolves worktrees against this repository, without following a moved checkout into another repo. */
async function worktreeTargets(repository: LocalPrRepository, entries: Worktree[]): Promise<WorktreeTarget[]> {
  const targets: WorktreeTarget[] = [];
  // A worktree's metadata must be the common directory or an immediate linked-worktree entry.
  for (const entry of entries.filter(({ bare }) => !bare)) {
    let root: string;
    let gitDir: string;
    try {
      root = await realpath(entry.root);
      gitDir = await realpath(gitLine(await localPrGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"])));
    } catch {
      // An unavailable worktree may have the target checked out or be mid-rebase; do not guess.
      throw new LocalPrError("WORKTREE_UNAVAILABLE", `A registered Git worktree is unavailable: ${entry.root}`);
    }
    const relative = path.relative(repository.repositoryId, gitDir);
    const components = relative.split(path.sep);
    if (relative && (components.length !== 2 || components[0] !== "worktrees")) {
      throw new LocalPrError("WORKTREE_UNAVAILABLE", "A worktree no longer belongs to this repository.");
    }
    targets.push({ ...entry, root, gitDir });
  }
  return targets;
}

/** Captures attachment, not unrelated changes to the tip of another attached branch. */
function attachment(entries: Worktree[]): string {
  return JSON.stringify(entries.map(({ root, branch, head, bare }) => [root, branch ?? head, bare]));
}

/** Produces a HEAD verify that cannot silently dereference or reattach the checkout. */
function verifyWorktreeHead(worktree: Worktree): string[] {
  const branch = worktree.branch;
  if (branch && (!branch.startsWith("refs/heads/") || /\s/u.test(branch))) {
    throw new LocalPrError("WORKTREE_UNAVAILABLE", "A worktree points to an unsupported HEAD ref.");
  }
  return ["option no-deref", branch ? `symref-verify HEAD ${branch}` : `verify HEAD ${gitObjectId(worktree.head ?? "")}`];
}

/** Holds each other HEAD in its own Git process: update-ref cannot verify another worktree's pseudo-ref directly. */
async function withWorktreeHeadLocks<T>(targets: WorktreeTarget[], operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
  const guards: (() => void)[] = [];
  const lockNext = async (index: number): Promise<T> => {
    const worktree = targets[index];
    if (!worktree) return operation(() => guards.forEach((guard) => guard()));
    return withPreparedLocalPrRefs(worktree.root, verifyWorktreeHead(worktree), async (_commit, assertHeld) => {
      guards.push(assertHeld);
      // Keep this verification prepared until the target ref transaction has finished.
      return lockNext(index + 1);
    });
  };
  return lockNext(0);
}

/** A detached worktree can still be rebasing or bisecting the target branch. */
async function requireNoOperation(target: WorktreeTarget): Promise<void> {
  for (const name of inProgressPaths) {
    try {
      await lstat(path.join(target.gitDir, name));
    } catch (error) {
      // Missing state files are normal; inaccessible metadata is not.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new LocalPrError("WORKTREE_BUSY", `Finish the Git operation in ${target.root} before merging this PR.`);
  }
}

/** Reads Git settings as data; merge/status/checkout must not launch repository-configured commands. */
async function config(root: string, regex: string): Promise<string[]> {
  const result = await runLocalPrGit(root, ["config", "-z", "--get-regexp", regex]);
  if (result.code !== 0 && (result.code !== 1 || !!result.stderr)) {
    throw new LocalPrError("GIT_FAILED", result.stderr || "Git config could not be read.");
  }
  return gitUtf8(result.stdout).split("\0").filter(Boolean);
}

/** Finds tree changes without consulting worktree files or custom diff drivers. */
async function checkoutPaths(root: string, old: string, next: string): Promise<string[]> {
  const entries = gitUtf8(await localPrGit(root, [
    "diff-tree", "--raw", "-z", "--no-commit-id", "--no-renames", "--no-ext-diff", "--ignore-submodules=none", "-r", old, next, "--",
  ])).split("\0");
  const paths: string[] = [];
  // A gitlink change additionally needs a submodule checkout, outside this transaction.
  for (let i = 0; i < entries.length - 1; i += 2) {
    if (/^:160000 |^:\d+ 160000 /u.test(entries[i])) {
      throw new LocalPrError("UNSUPPORTED_WORKTREE", "Merge this submodule change in Git; WithMate cannot update nested worktrees.");
    }
    paths.push(entries[i + 1]);
  }
  return paths;
}

/** Returns absolute-path independent comparisons for files and file/directory transitions. */
function intersects(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Even a clean status can hide ignored, untracked files that read-tree would overwrite. */
async function requireNoUntrackedCollision(root: string, paths: string[]): Promise<void> {
  const normalized = (value: string) => {
    const name = value.replace(/\/$/u, "");
    return process.platform === "win32" || process.platform === "darwin" ? name.toLowerCase() : name;
  };
  const changed = paths.map(normalized);
  const untracked = gitUtf8(await localPrGit(root, ["ls-files", "--others", "--directory", "--no-empty-directory", "-z"])).split("\0");
  // Do not use exclude-standard: ignored files are protected too.
  for (const file of untracked.filter(Boolean)) {
    const name = normalized(file);
    if (changed.some((candidate) => intersects(candidate, name))) {
      throw new LocalPrError("WORKTREE_DIRTY", `An untracked or ignored path would be overwritten: ${file}`);
    }
  }
}

/** Checks whether configured external filters are selected by either live or pinned attributes. */
async function requireNoExternalFilter(root: string, paths: string[], old: string, next: string): Promise<void> {
  const filters = new Set((await config(root, "^filter\\..*\\.(clean|smudge|process)$"))
    .map((setting) => /^filter\.(.+)\.[^\n]+\n[^\n]/u.exec(setting)?.[1]).filter(Boolean));
  if (!filters.size) return;
  const tracked = gitUtf8(await localPrGit(root, ["ls-files", "-z"])).split("\0").filter(Boolean);
  const input = [...new Set([...tracked, ...paths])].map((file) => `${file}\0`).join("");
  if (!input) return;
  // Status uses live attributes; checkout/rollback may read the attributes from either tree.
  for (const source of [[], [`--attr-source=${old}`], [`--attr-source=${next}`]]) {
    const values = gitUtf8(await localPrGit(root, [...source, "check-attr", "-z", "--stdin", "filter"], input)).split("\0");
    for (let i = 2; i < values.length - 1; i += 3) {
      if (filters.has(values[i])) {
        throw new LocalPrError("UNSUPPORTED_WORKTREE", "This worktree uses an external Git checkout filter. Merge it directly in Git.");
      }
    }
  }
}

/** Refuses state hidden by index flags or staged, tracked, or ordinary untracked edits. */
async function requireCleanWorktree(root: string, paths: string[]): Promise<void> {
  const flags = gitUtf8(await localPrGit(root, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
  if (flags.some((entry) => !entry.startsWith("H "))) {
    throw new LocalPrError("UNSUPPORTED_WORKTREE", "The target index has sparse, ignored, or unmerged entries.");
  }
  const status = await localPrGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"]);
  if (status.length) {
    throw new LocalPrError("WORKTREE_DIRTY", "Commit or move work in the target worktree before merging this PR.");
  }
  await requireNoUntrackedCollision(root, paths);
}

/** Compares index and checkout to the given installed tree, without changing either. */
async function matchesInstalledTree(root: string, commit: string): Promise<boolean> {
  const index = await runLocalPrGit(root, ["diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", commit, "--"]);
  if (index.code !== 0) return false;
  // Git status verifies content when cached stat data is stale; diff-files alone can misreport such paths.
  const status = gitUtf8(await localPrGit(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--ignore-submodules=all"]));
  return status.split("\0").filter(Boolean).every((entry) => entry[1] === " ");
}

/** Plans and installs exactly one merge commit with the approved target and source as its parents. */
export async function mergeLocalPr(
  repository: LocalPrRepository, branch: string, version: LocalPrVersion, guard: () => void,
): Promise<string> {
  const old = gitObjectId(version.targetCommit);
  const head = gitObjectId(version.headCommit);
  if (old === head) throw new LocalPrError("NOTHING_TO_MERGE", "The submitted and target commits are the same.");
  const inventory = await worktrees(repository.root);
  const targets = await worktreeTargets(repository, inventory);
  const attached = targets.filter((entry) => entry.branch === branch);
  if (attached.length > 1) throw new LocalPrError("WORKTREE_BUSY", "The target branch is checked out in multiple worktrees.");
  const target = attached[0];
  const root = target?.root ?? repository.root;
  if ((await config(root, "^merge\\..*\\.driver$")).length) {
    throw new LocalPrError("UNSUPPORTED_MERGE", "External Git merge drivers cannot run through Local PR.");
  }
  // Only the approved objects participate; no refs are updated while computing the merge tree.
  const tree = await runLocalPrGit(root, [
    `--attr-source=${old}`, "-c", "merge.renormalize=false",
    "merge-tree", "--write-tree", "--no-messages", `--merge-base=${gitObjectId(version.mergeBaseCommit)}`, old, head,
  ]);
  if (tree.code === 1) throw new LocalPrError("MERGE_CONFLICT", "The submitted changes conflict with the approved target.");
  if (tree.code !== 0) throw new LocalPrError("GIT_FAILED", tree.stderr || "Git could not compute the merge tree.");
  const next = gitObjectId(gitLine(await localPrGit(root, [
    "commit-tree", gitObjectId(gitLine(tree.stdout)), "-p", old, "-p", head, "--no-gpg-sign",
    "-m", `Merge WithMate Local PR into ${branch.slice("refs/heads/".length)}`,
  ])));
  const others = targets.filter((entry) => entry.root !== root);
  const primary = targets.find((entry) => entry.root === root);
  if (!primary) throw new LocalPrError("WORKTREE_UNAVAILABLE", "The workspace is not a registered worktree.");
  // update HEAD locks both HEAD and its referent. A second verify of this HEAD would be a duplicate.
  const commands = target ? [`update HEAD ${next} ${old}`] : ["option no-deref", `update ${branch} ${next} ${old}`, ...verifyWorktreeHead(primary)];
  // Check the known topology under Git locks, including the exact symbolic HEAD for an attached update.
  const checkTopology = async () => {
    if (attachment(await worktrees(root)) !== attachment(inventory) || await readLocalPrBranch(root, branch) !== old
      || (target && gitLine(await localPrGit(root, ["symbolic-ref", "--quiet", "HEAD"])) !== branch)) {
      throw new LocalPrError("GIT_REF_CHANGED", "The target branch or worktree checkout changed. Refresh the PR.");
    }
    // Git treats a branch being rebased in a detached worktree as checked out too.
    await Promise.all(targets.filter((entry) => entry === target || !entry.branch).map(requireNoOperation));
    guard();
  };
  // Git has no global lock for registering entirely new worktrees. Check for a racing attachment
  // or ref movement again before persisting a success; a confirmed write is never undone here.
  const confirmCommitted = async () => {
    const expected = inventory.filter((entry) => !entry.bare && entry.branch === branch).map((entry) => entry.root);
    try {
      const actual = (await worktrees(root)).filter((entry) => !entry.bare && entry.branch === branch).map((entry) => entry.root);
      if (JSON.stringify(expected) === JSON.stringify(actual) && await readLocalPrBranch(root, branch) === next) return;
    } catch {
      // Git acknowledged the write but we could not confirm the resulting repository state.
    }
    throw new LocalPrError("MERGE_EFFECT_UNKNOWN",
      `Git committed ${next}, but the target ref or its checkout changed during confirmation. Inspect ${branch} before retrying.`, "unknown");
  };
  guard();
  return await withWorktreeHeadLocks(others, (assertOtherHeadsHeld) => withPreparedLocalPrRefs(root, commands, async (commit, assertPrimaryHeld) => {
    const assertHeld = () => {
      assertPrimaryHeld();
      assertOtherHeadsHeld();
    };
    await checkTopology();
    // An unattached branch needs only a CAS; all known worktree HEADs were locked and rechecked.
    if (!target) {
      assertHeld();
      await commit();
      await confirmCommitted();
      return next;
    }
    const paths = await checkoutPaths(root, old, next);
    await requireNoExternalFilter(root, paths, old, next);
    await requireCleanWorktree(root, paths);
    await localPrGit(root, [...checkoutArgs, "--dry-run", old, next]);
    await checkTopology();
    await requireNoUntrackedCollision(root, paths);
    guard();
    assertHeld();
    let installed = false;
    try {
      await localPrGit(root, [...checkoutArgs, old, next]);
      installed = true;
      await checkTopology();
      if (!await matchesInstalledTree(root, next)) throw new Error("Git did not install the expected index and checkout.");
      guard();
      assertHeld();
    } catch (error) {
      // Only restore a fully installed, still clean candidate; never overwrite concurrent edits.
      let restored = false;
      try {
        assertHeld();
        if (installed && await matchesInstalledTree(root, next)) {
          await requireNoUntrackedCollision(root, paths);
          await localPrGit(root, [...checkoutArgs, next, old]);
        }
        if (await matchesInstalledTree(root, old)) {
          await requireNoUntrackedCollision(root, paths);
          restored = true;
        }
      } catch {
        // A failed inspection or unsafe restoration is not proof of the old state.
      }
      if (restored) throw new LocalPrError("WORKTREE_UPDATE_FAILED", error instanceof Error ? error.message : "Git could not update the target checkout.");
      throw new LocalPrError("MERGE_EFFECT_UNKNOWN",
        `The ref update was not requested, but the checkout may have changed. Inspect ${root} before retrying.`, "unknown");
    }
    // After commit is requested, loss of its acknowledgement must not trigger a worktree rollback.
    try {
      await commit();
    } catch (error) {
      // Inspect the ref if possible, but another process may now own it, so do not revert the checkout.
      const current = await readLocalPrBranch(root, branch).catch(() => null);
      const outcome = current ? `The target currently points to ${current}.` : "The target ref could not be confirmed.";
      const reason = error instanceof Error ? error.message : "Git did not confirm the ref update.";
      throw new LocalPrError("MERGE_EFFECT_UNKNOWN", `${reason} ${outcome} Inspect the checkout at ${root} before retrying.`, "unknown");
    }
    await confirmCommitted();
    return next;
  }));
}
