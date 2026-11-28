import { lstat } from "node:fs/promises";
import path from "node:path";
import type { LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";
import { RuntimeTurnInactiveError } from "../platform/agent-runtime/runtime-turn-admission.js";
import {
  gitLine, gitObjectId, gitUtf8, LocalPrError, localPrEmptyGitConfigEnv, localPrGit, readLocalPrBranch, resolveLocalPrRepository,
  runLocalPrGit, verifyLocalPrCommit, type LocalPrRepository,
} from "./local-pr-git.js";

const operationPaths = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"];
const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=dirty"];

/** 対象 ref の既存チェックアウトを使う。切り替えたり作成したりしない。 */
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
    // 一覧にあるチェックアウトが存在しないか使えない場合も、呼び出し元の worktree で代用しない。
    throw new LocalPrError("WORKTREE_UNAVAILABLE", "Git could not open the target checkout.");
  }
  // 古い worktree の情報によって、マージ先が別のリポジトリや親ディレクトリに変わってはならない。
  if (checkout.repositoryId !== repository.repositoryId || checkout.root !== checkout.workspacePath) {
    throw new LocalPrError("WORKTREE_UNAVAILABLE", "The target checkout no longer belongs to this repository.");
  }
  return checkout.root;
}

/** 進行中の Git 操作には手を加えず、ユーザーが Git で完了できるようにする。 */
async function requireNoOperation(root: string): Promise<void> {
  const gitDir = gitLine(await localPrGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  for (const name of operationPaths) {
    try {
      await lstat(path.join(gitDir, name));
    } catch (error) {
      // 状態ファイルが存在しないのは正常だが、メタデータにアクセスできない場合は別。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new LocalPrError("WORKTREE_BUSY", `Finish the Git operation in ${root} before merging this PR.`);
  }
}

/** 実際の HEAD と、マージ先を直接指す ref を個別に確認する。 */
async function checkoutState(root: string, branch: string) {
  const [symbolic, head, target] = await Promise.all([
    runLocalPrGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    localPrGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    readLocalPrBranch(root, branch),
  ]);
  if (symbolic.code > 1) throw new LocalPrError("GIT_FAILED", symbolic.stderr || "Git could not read the checkout branch.");
  return { branch: symbolic.code === 0 ? gitLine(symbolic.stdout) : null, head: gitObjectId(gitLine(head)), target };
}

/** 想定どおりのマージを確認するか、Git の状態を変更せず観測結果を報告する。 */
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
    // 起動後にコマンドが失敗しても、Git が何も変更しなかったとは限らない。
    throw new LocalPrError("MERGE_EFFECT_UNKNOWN", `${reason} Git state could not be verified in ${root}.`, "unknown");
  }

  const sameTarget = state.branch === branch && state.head === state.target;
  const unchanged = sameTarget && state.head === old;
  const manual = merging ? ` Git left a merge in progress in ${root}.` : ` Inspect ${root} before retrying.`;
  if (result?.code === 1 && unchanged && merging) {
    // コミットが失敗しただけでも MERGE_HEAD は残り得るため、未マージのエントリを確認する。
    const unmerged = await runLocalPrGit(root, ["ls-files", "--unmerged", "-z"]).catch(() => null);
    if (unmerged?.code === 0 && unmerged.stdout.length) {
      throw new LocalPrError("MERGE_CONFLICT", `Git reported merge conflicts.${manual}`, "unknown");
    }
  }
  const status = sameTarget && !merging ? await localPrGit(root, statusArgs).catch(() => null) : null;
  const clean = status?.length === 0;
  if (result?.code === 0 && clean) {
    if (unchanged) {
      // Git の出力文言に依存せず、変更がなかったことを確認する。
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

/** 固定したマージ元を、チェックアウト済みで承認されたマージ先に Git でマージする。 */
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
  // 承認済みのチェックアウトを確認する際、Git が設定済みの clean フィルターを起動することがある。
  guard();
  try {
    return await mergeCheckedOutVersion(root, branch, old, source, guard);
  } catch (error) {
    // Git の status や merge が設定済みプログラムを実行した後で、操作を拒否する場合がある。
    if (error instanceof LocalPrError && error.effect === "unknown") throw error;
    const code = error instanceof LocalPrError ? error.code : error instanceof RuntimeTurnInactiveError
      ? "RUNTIME_TURN_INACTIVE" : "MERGE_EFFECT_UNKNOWN";
    const message = error instanceof LocalPrError || error instanceof RuntimeTurnInactiveError
      ? error.message : "Git could not complete the merge checks.";
    throw new LocalPrError(code, `${message} Inspect the checkout for effects of configured Git programs.`, "unknown");
  }
}

/** 承認済みチェックアウトの検査と Git の実行は、いずれもそのチェックアウトのフィルター設定を使う。 */
async function mergeCheckedOutVersion(
  root: string, branch: string, old: string, source: string, guard: () => void,
): Promise<string> {
  if ((await localPrGit(root, statusArgs)).length) {
    throw new LocalPrError("WORKTREE_DIRTY", "Commit or move work in the target checkout, then retry the merge.");
  }

  // Git の通常のマージは実際のチェックアウトを使う。この最終照合は、プロセスの起動や、
  // 別の Git プロセスやエディターによる変更に対してアトミックではない。
  await verifyLocalPrCommit(root, source);
  const before = await checkoutState(root, branch);
  if (before.branch !== branch || before.head !== old || before.target !== old) {
    throw new LocalPrError("GIT_REF_CHANGED", "The target branch or its checkout changed. Refresh the PR before retrying.");
  }
  guard();
  let result: Awaited<ReturnType<typeof runLocalPrGit>> | undefined;
  let reason: string;
  try {
    // Git 2.49 でマージコミットを作るマージは、同じパスにある既存の無視対象ファイルを上書きする場合がある。
    // この実行経路では、--no-overwrite-ignore を指定しても保護は保証されない。
    result = await runLocalPrGit(root, [
      "-c", "submodule.recurse=false",
      // Git は -s の指定があっても branch.mergeOptions を追加する。--config-env ならブランチ名に '=' がある場合も扱える。
      `--config-env=branch.${branch.slice("refs/heads/".length)}.mergeOptions=${localPrEmptyGitConfigEnv}`,
      "merge", "-s", "ort", "--no-ff", "--no-squash", "--commit", "--no-edit", "--no-autostash",
      "--no-gpg-sign", "--no-stat", "--no-overwrite-ignore", "--", source,
    ]);
    reason = result.code === 0 ? "Git did not confirm the expected merge." : (result.stderr || result.stdout.toString("utf8").trimEnd() || `Git merge exited with code ${result.code}.`);
  } catch (error) {
    // プロセスの中断と負の終了ステータスでは、副作用について保証できることが異なる。
    reason = error instanceof Error ? error.message : "Git merge did not complete.";
  }
  return mergeOutcome(root, branch, old, source, result, reason);
}
