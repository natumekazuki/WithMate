import { z } from "zod";
import { localPrAgentData, localPrAgentInput, type LocalPrAgentOperation } from "./local-pr-contract.js";

/** Agent 操作だけを認識する。継承されたキーや GUI 操作は対象外。 */
export function isLocalPrAgentOperation(operation: string): operation is LocalPrAgentOperation {
  return Object.hasOwn(localPrAgentInput, operation);
}

/** Session MCP と CLI で、PR 操作の成功レスポンスの外枠とデータ構造を共有する。 */
export const localPrAgentSuccessSchemas = Object.fromEntries(
  Object.entries(localPrAgentData).map(([operation, data]) => [operation, z.strictObject({ ok: z.literal(true), data })]),
) as { [K in LocalPrAgentOperation]: z.ZodObject<{ ok: z.ZodLiteral<true>; data: (typeof localPrAgentData)[K] }> };

/** 読み取り操作の分類は、通信上の操作効果の報告と MCP ツールのアノテーションに使う。 */
export const LOCAL_PR_AGENT_READS = [
  "pr_list", "pr_branches", "pr_get", "pr_diff", "pr_ci_validate", "pr_ci_list", "pr_ci_log",
] as const satisfies readonly LocalPrAgentOperation[];

/** CI は Provider のコマンド実行境界の外側にある WithMate 側で実行する。 */
export const LOCAL_PR_CI_EXECUTION_NOTICE = "Local PR CI commands run with the WithMate application's OS permissions, not in the Provider sandbox.";

/** Agent 共通の手順。紐付け先のリポジトリでのマージにだけ適用する。 */
export const LOCAL_PR_AGENT_WORKFLOW = "To merge work from a WithMate Session, submit a WithMate local PR, wait for user approval in the WithMate GUI, and merge through that PR. Do not use direct Git merge as a substitute. WithMate does not block external Git commands. Local PR tools act on the repository of the bound Session workspace.";

/** CLI のヘルプ・スキーマと MCP のツール一覧は、同じ公開操作を記述する。 */
export const LOCAL_PR_AGENT_DESCRIPTIONS = {
  pr_list: "List local PRs in the bound Session repository.",
  pr_branches: "List local branches and the bound checkout's HEAD for preparing a submission.",
  pr_get: "Read a PR, submitted versions, published comments and the recorded GUI approval.",
  pr_create: "Create a local PR from an exact committed head against the selected local target branch.",
  pr_submit: "Submit a new version of a PR from an exact committed head. Compare and review the new version separately.",
  pr_close: "Close an open PR at its expected version without merging it.",
  pr_diff: "Read a submitted version's fixed full or previous-version diff. Specify a path to read that file's patch.",
  pr_comment: "Publish a comment or reply on an exact submitted version. Omit the anchor for a PR-wide comment, use null for both line values for a file comment, or use an ordered pair of positive line numbers for a line range. This does not start a Session Turn.",
  pr_merge: "Merge the exact version and commit pair only if it has a current user approval recorded in the WithMate GUI.",
  pr_ci_validate: "Read and validate .withmate/ci.yml from the exact submitted head without running commands.",
  pr_ci_list: "List CI runs for the exact submitted version.",
  pr_ci_start: `Start CI using .withmate/ci.yml from the submitted head. ${LOCAL_PR_CI_EXECUTION_NOTICE}`,
  pr_ci_cancel: "Cancel an active CI run for the specified PR and version.",
  pr_ci_rerun: `Run CI again for the specified run's submitted version. ${LOCAL_PR_CI_EXECUTION_NOTICE}`,
  pr_ci_log: "Read a page of log output from a specific CI run and submitted version.",
} satisfies Record<LocalPrAgentOperation, string>;
