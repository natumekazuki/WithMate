import type { ApprovalMode } from "../settings/approval-mode.js";
import type { CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "../settings/model-catalog.js";

export type SessionTurnPhase = "running" | "completed" | "failed" | "canceled";

export type SessionTurnRecord = {
  id: number;
  sessionId: string;
  createdAt: string;
  phase: SessionTurnPhase;
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  sandboxMode?: CodexSandboxMode;
  userMessageSeq?: number;
  assistantMessageSeq?: number;
  threadId: string;
  errorMessage: string;
  completedAt?: string;
  updatedAt?: string;
};

export type SessionTurnInput = Omit<SessionTurnRecord, "id">;

export type UnreadSessionResult = {
  turnId: number;
  assistantMessageSeq: number;
};
