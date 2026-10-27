import { APPROVAL_MODE_VALUES, type ApprovalMode } from "../settings/approval-mode.js";
import { getApprovalOptionsForProvider } from "../settings/provider-runtime-options.js";
import { CODEX_REVIEWER_VALUES, type CodexReviewer } from "../settings/codex-reviewer.js";
import { CODEX_SANDBOX_MODE_VALUES, type CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import { CODEX_SPEED_VALUES, type CodexSpeed } from "../settings/codex-speed.js";
import { isModelReasoningEffort, type ModelCatalogProvider, type ModelReasoningEffort } from "../settings/model-catalog.js";
import type { Session } from "./session-state.js";

export type SessionExecutionOptions = Readonly<{
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  codexReviewer: CodexReviewer;
  customAgentName: string;
}>;

export function captureSessionExecutionOptions(source: Pick<Session, keyof SessionExecutionOptions>): SessionExecutionOptions {
  return Object.freeze({
    model: source.model,
    reasoningEffort: source.reasoningEffort,
    approvalMode: source.approvalMode,
    codexSandboxMode: source.codexSandboxMode,
    codexSpeed: source.codexSpeed,
    codexReviewer: source.codexReviewer,
    customAgentName: source.customAgentName,
  });
}

export function validateSessionExecutionOptions(
  value: unknown,
  providerCatalog: ModelCatalogProvider,
): SessionExecutionOptions {
  if (!value || typeof value !== "object") {
    throw new Error("Turn execution options are required.");
  }
  const candidate = value as Partial<SessionExecutionOptions>;
  if (typeof candidate.model !== "string" || !candidate.model.trim()) {
    throw new Error("The selected model is invalid.");
  }
  if (!isModelReasoningEffort(candidate.reasoningEffort)) {
    throw new Error("The selected reasoning effort is invalid.");
  }
  if (!APPROVAL_MODE_VALUES.includes(candidate.approvalMode as ApprovalMode)) {
    throw new Error("The selected approval mode is invalid.");
  }
  if (!getApprovalOptionsForProvider(providerCatalog.id).some((option) => option.value === candidate.approvalMode)) {
    throw new Error("The selected approval mode is not supported by this provider.");
  }
  if (!CODEX_SANDBOX_MODE_VALUES.includes(candidate.codexSandboxMode as CodexSandboxMode)) {
    throw new Error("The selected sandbox mode is invalid.");
  }
  if (!CODEX_SPEED_VALUES.includes(candidate.codexSpeed as CodexSpeed)) {
    throw new Error("The selected speed is invalid.");
  }
  if (!CODEX_REVIEWER_VALUES.includes(candidate.codexReviewer as CodexReviewer)) {
    throw new Error("The selected reviewer is invalid.");
  }
  if (typeof candidate.customAgentName !== "string") {
    throw new Error("The selected custom agent is invalid.");
  }
  return Object.freeze({
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    approvalMode: candidate.approvalMode as ApprovalMode,
    codexSandboxMode: candidate.codexSandboxMode as CodexSandboxMode,
    codexSpeed: candidate.codexSpeed as CodexSpeed,
    codexReviewer: candidate.codexReviewer as CodexReviewer,
    customAgentName: candidate.customAgentName,
  });
}
