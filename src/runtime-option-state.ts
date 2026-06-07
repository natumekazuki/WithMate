import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";

type ApprovalModeSessionLike = {
  approvalMode: ApprovalMode;
};

type CodexSandboxModeSessionLike = {
  codexSandboxMode: CodexSandboxMode;
};

export function buildSessionWithApprovalMode<TSession extends ApprovalModeSessionLike>(
  session: TSession,
  approvalMode: ApprovalMode,
  updatedAt: string,
): (TSession & { approvalMode: ApprovalMode; updatedAt: string }) | null {
  if (approvalMode === session.approvalMode) {
    return null;
  }
  return {
    ...session,
    approvalMode,
    updatedAt,
  };
}

export function buildSessionWithCodexSandboxMode<TSession extends CodexSandboxModeSessionLike>(
  session: TSession,
  codexSandboxMode: CodexSandboxMode,
  updatedAt: string,
): (TSession & { codexSandboxMode: CodexSandboxMode; updatedAt: string }) | null {
  if (codexSandboxMode === session.codexSandboxMode) {
    return null;
  }
  return {
    ...session,
    codexSandboxMode,
    updatedAt,
  };
}
