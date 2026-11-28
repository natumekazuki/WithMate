import type { ApprovalMode } from "../settings/approval-mode.js";
import type { CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "../settings/model-catalog.js";

/** Turnの進行中と、成功・失敗・取消の各終了状態。 */
export type SessionTurnPhase = "running" | "completed" | "failed" | "canceled";

/** 一つのTurnの実行設定、進行状態と、関連する会話メッセージの保存位置。 */
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

/** 保存先がTurn IDを付ける前に渡す記録内容。 */
export type SessionTurnInput = Omit<SessionTurnRecord, "id">;

/** 未読表示の対象となるTurnと、そのアシスタント応答の会話連番。 */
export type UnreadSessionResult = {
  turnId: number;
  assistantMessageSeq: number;
};
