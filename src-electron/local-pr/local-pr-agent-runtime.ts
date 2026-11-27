import { isAbsolute, parse } from "node:path";
import { localPrAgentInput, type LocalPrAgentOperation, type LocalPrInput, type LocalPrResult } from "../../src-shared/local-pr/local-pr-contract.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { matchesRelatedSession, type SessionManagementScope } from "../session/session-relationship-resolver.js";

/** Exact saved actor and bound checkout, never values supplied in the PR request. */
export type LocalPrAgentContext = Readonly<{
  actor: SessionTarget;
  workspacePath: string;
  providerId: string;
  executionOptions: SessionExecutionOptions | undefined;
  assertCurrent(): void;
}>;

/** The common application owns PR/CI effects and the GUI Approval merge gate. */
export type LocalPrAgentRuntimeDeps = {
  // The executor must use the bound workspace and guard each effect after any async preparation.
  execute<K extends LocalPrAgentOperation>(operation: K, input: LocalPrInput<K>, context: LocalPrAgentContext): Promise<LocalPrResult<K>>;
};

/** Validate the direct runtime request and resolve its authority before handing it to the application. */
export async function executeLocalPrAgentOperation<K extends LocalPrAgentOperation>(input: {
  deps?: LocalPrAgentRuntimeDeps;
  operation: K;
  body: unknown;
  binding: Omit<LocalPrAgentContext, "workspacePath"> & { workspacePath: unknown };
  readSavedScope: (actor: SessionTarget) => Promise<SessionManagementScope>;
}): Promise<LocalPrResult<K>> {
  const { deps, operation, body, binding } = input;
  const parsed = localPrAgentInput[operation].safeParse(body);
  // Direct exchange clients are held to the same strict schema as MCP and CLI.
  if (!parsed.success) return { ok: false, code: "SESSION_INVALID_REQUEST", message: parsed.error.message, effect: "none" };
  const workspacePath = binding.workspacePath;
  // Missing or ambiguous workspace authority must not fall back to process cwd or the selected window.
  if (typeof workspacePath !== "string" || workspacePath.includes("\0") || !isAbsolute(workspacePath)
    || (process.platform === "win32" && parse(workspacePath).root.length <= 1)) {
    return { ok: false, code: "SESSION_BINDING_INVALID", message: "The binding has no exact saved Session workspace.", effect: "none" };
  }
  const { actor: saved } = await input.readSavedScope(binding.actor);
  binding.assertCurrent();
  // Compare with the exact saved identity (including an Auxiliary's owning Main), provider and workspace.
  if (!saved || !matchesRelatedSession(saved, binding.actor) || saved.provider !== binding.providerId || saved.workspacePath !== workspacePath) {
    return { ok: false, code: "SESSION_BINDING_INVALID", message: "The bound Session, provider or workspace is no longer current.", effect: "none" };
  }
  // An unassembled application cannot perform any PR action.
  if (!deps) return { ok: false, code: "LOCAL_PR_UNAVAILABLE", message: "Local PR operations are unavailable.", effect: "none" };

  // Indexing an operation's schema with K preserves its input association at this boundary.
  return deps.execute(operation, parsed.data as LocalPrInput<K>, { ...binding, workspacePath });
}
