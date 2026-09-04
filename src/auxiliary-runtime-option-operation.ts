import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { CodexSpeed } from "./codex-speed.js";
import type { CodexReviewer } from "./codex-reviewer.js";
import {
  applyAuxiliarySessionApprovalModeChange,
  applyAuxiliarySessionCodexSandboxModeChange,
  applyAuxiliarySessionCodexSpeedChange,
  applyAuxiliarySessionCodexReviewerChange,
  applyAuxiliarySessionModelChange,
  applyAuxiliarySessionReasoningEffortChange,
  type AuxiliarySession,
} from "./auxiliary-session-state.js";
import type { ModelCatalogProvider, ModelReasoningEffort } from "./model-catalog.js";

type UpdateActiveAuxiliarySession = (
  recipe: (current: AuxiliarySession) => AuxiliarySession,
) => Promise<void>;

export async function runAuxiliaryApprovalModeChangeOperation(input: {
  approvalMode: ApprovalMode;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionApprovalModeChange(current, input.approvalMode, input.createTimestampLabel())
  ));
}

export async function runAuxiliarySandboxModeChangeOperation(input: {
  codexSandboxMode: CodexSandboxMode;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionCodexSandboxModeChange(current, input.codexSandboxMode, input.createTimestampLabel())
  ));
}

export async function runAuxiliaryCodexSpeedChangeOperation(input: {
  codexSpeed: CodexSpeed;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionCodexSpeedChange(current, input.codexSpeed, input.createTimestampLabel())
  ));
}

export async function runAuxiliaryCodexReviewerChangeOperation(input: {
  codexReviewer: CodexReviewer;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionCodexReviewerChange(current, input.codexReviewer, input.createTimestampLabel())
  ));
}

export async function runAuxiliaryModelChangeOperation(input: {
  model: string;
  providerCatalog: ModelCatalogProvider;
  catalogRevision: number;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionModelChange(
      current,
      input.providerCatalog,
      input.model,
      input.catalogRevision,
      input.createTimestampLabel(),
    )
  ));
}

export async function runAuxiliaryReasoningEffortChangeOperation(input: {
  reasoningEffort: ModelReasoningEffort;
  providerCatalog: ModelCatalogProvider;
  catalogRevision: number;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionReasoningEffortChange(
      current,
      input.providerCatalog,
      input.reasoningEffort,
      input.catalogRevision,
      input.createTimestampLabel(),
    )
  ));
}
