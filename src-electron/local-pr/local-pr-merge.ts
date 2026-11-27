import { lstat } from "node:fs/promises";
import path from "node:path";
import type { LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";
import {
  gitLine, gitObjectId, gitUtf8, LocalPrError, localPrEmptyGitConfigEnv, localPrGit, readLocalPrBranch, resolveLocalPrRepository,
  runLocalPrGit, verifyLocalPrCommit, type LocalPrRepository,
} from "./local-pr-git.js";

const operationPaths = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"];
const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=dirty"];

/** Uses the existing checkout of the exact target ref; never switches or creates one. */
async function targetWorktree(repository: LocalPrRepository, branch: string): Promise<string> {
  const listing = gitUtf8(await localPrGit(repository.root, ["worktree", "list", "--porcelain", "-z"]));
  const attached = listing.split("\0\0").map((record) => record.split("\0")).filter((fields) =>
    fields[0].startsWith("worktree ") && !fields.includes("bare") && fields.includes(`branch ${branch}`));
  if (attached.length === 0) {
    throw new LocalPrError("TARGET_NOT_CHECKED_OUT", `Check out ${branch} in Git, then retry the merge.`);
  }
  if (attached.length > 1) {
    throw new LocalPrError("WORKTREE_BUSY", "The target branch is checked out in multiple worktrees.");
  }
  let checkout: LocalPrRepository;
  try {
    checkout = await resolveLocalPrRepository(attached[0][0].slice(9));
  } catch {
    // A listed checkout may be missing or unavailable; do not fall back to the caller's worktree.
    throw new LocalPrError("WORKTREE_UNAVAILABLE", "Git could not open the target checkout.");
  }
  // A stale worktree entry must not redirect a merge to a different repository or into its parent.
  if (checkout.repositoryId !== repository.repositoryId || checkout.root !== checkout.workspacePath) {
    throw new LocalPrError("WORKTREE_UNAVAILABLE", "The target checkout no longer belongs to this repository.");
  }
  return checkout.root;
}

/** Leaves any existing Git operation available for the user to finish in Git. */
async function requireNoOperation(root: string): Promise<void> {
  const gitDir = gitLine(await localPrGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  for (const name of operationPaths) {
    try {
      await lstat(path.join(gitDir, name));
    } catch (error) {
      // Missing state files are normal; inaccessible metadata is not.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new LocalPrError("WORKTREE_BUSY", `Finish the Git operation in ${root} before merging this PR.`);
  }
}

/** Inspects actual HEAD and the direct target ref independently. */
async function checkoutState(root: string, branch: string) {
  const [symbolic, head, target] = await Promise.all([
    runLocalPrGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    localPrGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    readLocalPrBranch(root, branch),
  ]);
  if (symbolic.code > 1) throw new LocalPrError("GIT_FAILED", symbolic.stderr || "Git could not read the checkout branch.");
  return { branch: symbolic.code === 0 ? gitLine(symbolic.stdout) : null, head: gitObjectId(gitLine(head)), target };
}

/** Confirms the expected merge, or reports Git's observed state without changing it. */
async function mergeOutcome(
  root: string, branch: string, old: string, source: string,
  result: Awaited<ReturnType<typeof runLocalPrGit>> | undefined, reason: string,
): Promise<string> {
  let state: Awaited<ReturnType<typeof checkoutState>>;
  let merging: boolean;
  try {
    state = await checkoutState(root, branch);
    const mergeHead = await runLocalPrGit(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
    if (mergeHead.code > 1) throw new Error("Git could not read MERGE_HEAD.");
    merging = mergeHead.code === 0;
  } catch {
    // A command failure after launch is not proof that Git made no changes.
    throw new LocalPrError("MERGE_EFFECT_UNKNOWN", `${reason} Git state could not be verified in ${root}.`, "unknown");
  }

  const sameTarget = state.branch === branch && state.head === state.target;
  const unchanged = sameTarget && state.head === old;
  const manual = merging ? ` Git left a merge in progress in ${root}.` : ` Inspect ${root} before retrying.`;
  if (result?.code === 1 && unchanged && merging) {
    // MERGE_HEAD by itself can also be left by a failed commit; verify unmerged entries.
    const unmerged = await runLocalPrGit(root, ["ls-files", "--unmerged", "-z"]).catch(() => null);
    if (unmerged?.code === 0 && unmerged.stdout.length) {
      throw new LocalPrError("MERGE_CONFLICT", `Git reported merge conflicts.${manual}`, "unknown");
    }
  }
  const status = sameTarget && !merging ? await localPrGit(root, statusArgs).catch(() => null) : null;
  const clean = status?.length === 0;
  if (result?.code === 0 && clean) {
    if (unchanged) {
      // Confirm Git's no-op without depending on the wording of its output.
      const included = await runLocalPrGit(root, ["merge-base", "--is-ancestor", source, old]).catch(() => null);
      if (included?.code === 0) {
        throw new LocalPrError("ALREADY_UP_TO_DATE", "The target already contains the submitted commit. No merge commit was created.");
      }
    } else {
      const parents = await runLocalPrGit(root, ["rev-list", "--parents", "-n", "1", state.head]).catch(() => null);
      if (parents?.code === 0 && gitLine(parents.stdout) === `${state.head} ${old} ${source}`) return state.head;
    }
  }
  if (result && result.code !== 0 && unchanged && clean) {
    throw new LocalPrError("GIT_FAILED", reason);
  }
  const target = state.target === null ? `${branch} is missing.` : `${branch} points to ${state.target}.`;
  const checkout = sameTarget ? "" : ` Worktree HEAD is ${state.branch ?? "detached"} at ${state.head}.`;
  throw new LocalPrError("MERGE_EFFECT_UNKNOWN", `${reason} ${target}${checkout}${manual}`, "unknown");
}

/** Lets Git merge the fixed source into the checked-out, approved target. */
export async function mergeLocalPr(
  repository: LocalPrRepository, branch: string, version: LocalPrVersion, guard: () => void,
): Promise<string> {
  const old = gitObjectId(version.targetCommit);
  const source = gitObjectId(version.headCommit);
  const root = await targetWorktree(repository, branch);
  await requireNoOperation(root);

  const flags = gitUtf8(await localPrGit(root, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
  if (flags.some((entry) => !entry.startsWith("H "))) {
    throw new LocalPrError("UNSUPPORTED_WORKTREE", "The target index has sparse, ignored, or unmerged entries.");
  }
  // Git may run a configured clean filter while checking the approved checkout.
  guard();
  if ((await localPrGit(root, statusArgs)).length) {
    throw new LocalPrError("WORKTREE_DIRTY", "Commit or move work in the target checkout, then retry the merge.");
  }

  // Git's normal merge uses the actual checkout. This last comparison is not atomic
  // with process launch or with changes made by another Git process or editor.
  await verifyLocalPrCommit(root, source);
  const before = await checkoutState(root, branch);
  if (before.branch !== branch || before.head !== old || before.target !== old) {
    throw new LocalPrError("GIT_REF_CHANGED", "The target branch or its checkout changed. Refresh the PR before retrying.");
  }
  guard();
  let result: Awaited<ReturnType<typeof runLocalPrGit>> | undefined;
  let reason: string;
  try {
    // Git 2.49's true merge may overwrite an existing ignored file at the same path.
    // --no-overwrite-ignore is not a protection guarantee for this Git path.
    result = await runLocalPrGit(root, [
      "-c", "submodule.recurse=false",
      // Git appends branch.mergeOptions even with -s. --config-env also handles '=' in the branch name.
      `--config-env=branch.${branch.slice("refs/heads/".length)}.mergeOptions=${localPrEmptyGitConfigEnv}`,
      "merge", "-s", "ort", "--no-ff", "--no-squash", "--commit", "--no-edit", "--no-autostash",
      "--no-gpg-sign", "--no-stat", "--no-overwrite-ignore", "--", source,
    ]);
    reason = result.code === 0 ? "Git did not confirm the expected merge." : (result.stderr || result.stdout.toString("utf8").trimEnd() || `Git merge exited with code ${result.code}.`);
  } catch (error) {
    // Process interruption and a negative exit status have different effect guarantees.
    reason = error instanceof Error ? error.message : "Git merge did not complete.";
  }
  return mergeOutcome(root, branch, old, source, result, reason);
}
