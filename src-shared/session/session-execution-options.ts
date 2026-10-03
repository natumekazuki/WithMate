import { APPROVAL_MODE_VALUES, type ApprovalMode } from "../settings/approval-mode.js";
import { getApprovalOptionsForProvider } from "../settings/provider-runtime-options.js";
import { CODEX_REVIEWER_VALUES, type CodexReviewer } from "../settings/codex-reviewer.js";
import { CODEX_SANDBOX_MODE_VALUES, type CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import { CODEX_SPEED_VALUES, type CodexSpeed } from "../settings/codex-speed.js";
import { isModelReasoningEffort, type ModelCatalogProvider, type ModelReasoningEffort } from "../settings/model-catalog.js";
import type { Session } from "./session-state.js";

export type SessionExecutionOptions = Readonly<{
  catalogRevision: number;
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
    catalogRevision: source.catalogRevision,
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
  catalogRevision: number,
): SessionExecutionOptions {
  if (!value || typeof value !== "object") {
    throw new Error("Turn execution options are required.");
  }
  const candidate = value as Partial<SessionExecutionOptions>;
  if (!Number.isInteger(candidate.catalogRevision) || candidate.catalogRevision !== catalogRevision || catalogRevision <= 0) {
    throw new Error("The selected model catalog revision is invalid.");
  }
  if (typeof candidate.model !== "string" || !candidate.model.trim()) {
    throw new Error("The selected model is invalid.");
  }
  const model = providerCatalog.models.find((entry) => entry.id === candidate.model);
  if (!model) {
    throw new Error("The selected model is not in the model catalog.");
  }
  if (!isModelReasoningEffort(candidate.reasoningEffort) || !model.reasoningEfforts.includes(candidate.reasoningEffort)) {
    throw new Error("The selected reasoning effort is not supported by this model.");
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
    catalogRevision,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    approvalMode: candidate.approvalMode as ApprovalMode,
    codexSandboxMode: candidate.codexSandboxMode as CodexSandboxMode,
    codexSpeed: candidate.codexSpeed as CodexSpeed,
    codexReviewer: candidate.codexReviewer as CodexReviewer,
    customAgentName: candidate.customAgentName,
  });
}
