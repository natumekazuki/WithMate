import { isAbsolute, parse } from "node:path";
import { localPrAgentInput, type LocalPrAgentOperation, type LocalPrInput, type LocalPrResult } from "../../src-shared/local-pr/local-pr-contract.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { matchesRelatedSession, type SessionManagementScope } from "../session/session-relationship-resolver.js";

/** 保存済みの実行主体と紐付けられたチェックアウトを厳密に用いる。PR 要求で指定された値は使わない。 */
export type LocalPrAgentContext = Readonly<{
  actor: SessionTarget;
  workspacePath: string;
  providerId: string;
  executionOptions: SessionExecutionOptions | undefined;
  assertCurrent(): void;
}>;

/** PR・CI の副作用と、GUI の承認を条件とするマージは共通アプリケーションが担う。 */
export type LocalPrAgentRuntimeDeps = {
  // 実行側は紐付けられたワークスペースを使い、非同期の準備後に各副作用の実行可否を確認する。
  execute<K extends LocalPrAgentOperation>(operation: K, input: LocalPrInput<K>, context: LocalPrAgentContext): Promise<LocalPrResult<K>>;
};

/** ランタイムへの直接要求を検証し、その権限を確定してからアプリケーションに渡す。 */
export async function executeLocalPrAgentOperation<K extends LocalPrAgentOperation>(input: {
  deps?: LocalPrAgentRuntimeDeps;
  operation: K;
  body: unknown;
  binding: Omit<LocalPrAgentContext, "workspacePath"> & { workspacePath: unknown };
  readSavedScope: (actor: SessionTarget) => Promise<SessionManagementScope>;
}): Promise<LocalPrResult<K>> {
  const { deps, operation, body, binding } = input;
  const parsed = localPrAgentInput[operation].safeParse(body);
  // 直接やり取りするクライアントにも、MCP や CLI と同じ厳密なスキーマを適用する。
  if (!parsed.success) return { ok: false, code: "SESSION_INVALID_REQUEST", message: parsed.error.message, effect: "none" };
  const workspacePath = binding.workspacePath;
  // ワークスペースの権限がないか曖昧な場合は、プロセスの cwd や選択中のウィンドウで代用しない。
  if (typeof workspacePath !== "string" || workspacePath.includes("\0") || !isAbsolute(workspacePath)
    || (process.platform === "win32" && parse(workspacePath).root.length <= 1)) {
    return { ok: false, code: "SESSION_BINDING_INVALID", message: "The binding has no exact saved Session workspace.", effect: "none" };
  }
  const { actor: saved } = await input.readSavedScope(binding.actor);
  binding.assertCurrent();
  // 保存された識別情報（Auxiliary の場合は所有する Main も含む）、プロバイダー、ワークスペースが厳密に一致するか確認する。
  if (!saved || !matchesRelatedSession(saved, binding.actor) || saved.provider !== binding.providerId || saved.workspacePath !== workspacePath) {
    return { ok: false, code: "SESSION_BINDING_INVALID", message: "The bound Session, provider or workspace is no longer current.", effect: "none" };
  }
  // アプリケーションが組み立てられていなければ、PR 操作は実行できない。
  if (!deps) return { ok: false, code: "LOCAL_PR_UNAVAILABLE", message: "Local PR operations are unavailable.", effect: "none" };

  // 操作のスキーマを K で参照して、この境界でも操作と入力型の対応を維持する。
  return deps.execute(operation, parsed.data as LocalPrInput<K>, { ...binding, workspacePath });
}
