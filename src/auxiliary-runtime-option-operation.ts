import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import {
  applyAuxiliarySessionApprovalModeChange,
  applyAuxiliarySessionCodexSandboxModeChange,
  type AuxiliarySession,
} from "./auxiliary-session-state.js";

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
