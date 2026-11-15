import type { ApprovalMode } from "../settings/approval-mode.js";
import type { CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import type { CodexReviewer } from "../settings/codex-reviewer.js";
import type { ModelReasoningEffort } from "../settings/model-catalog.js";

export type CreateChildSessionRequest = {
  requestId: string;
  role: "task-coordinator" | "executor";
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  codexReviewer?: CodexReviewer;
  workspacePath: string;
  title?: string;
  description?: string;
};
