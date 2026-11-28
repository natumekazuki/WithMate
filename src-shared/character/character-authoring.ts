import type { ApprovalMode } from "../settings/approval-mode.js";
import type { CodexSandboxMode } from "../settings/codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "../settings/model-catalog.js";
import type { Session } from "../session/session-state.js";

/** 新しい定義を作る作業と、既存のCharacterを改善する作業を区別する。 */
export type CharacterAuthoringMode = "create" | "improve";

/** 編集対象と、作業用Sessionで使うProvider・承認・モデルを指定する。 */
export type StartCharacterAuthoringSessionInput = {
  mode: CharacterAuthoringMode;
  characterId?: string | null;
  provider: string;
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

/** 作成された作業用Session、その編集先と、追跡する実行のID。 */
export type CharacterAuthoringSessionStartResult = {
  session: Session;
  workspacePath: string;
  runId: string;
};
