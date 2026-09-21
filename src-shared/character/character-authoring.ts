import type { ApprovalMode } from "../settings/approval-mode.js";
import type { CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "../settings/model-catalog.js";
import type { Session } from "../session/session-state.js";

export type CharacterAuthoringMode = "create" | "improve";

export type StartCharacterAuthoringSessionInput = {
  mode: CharacterAuthoringMode;
  characterId?: string | null;
  provider: string;
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

export type CharacterAuthoringSessionStartResult = {
  session: Session;
  workspacePath: string;
  runId: string;
};
