import type { ApprovalMode } from "../approval-mode.js";
import type { CodexSandboxMode } from "../codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "../model-catalog.js";
import type { Session } from "../session-state.js";
import type { CharacterTheme } from "./character-catalog.js";

export type CharacterAuthoringMode = "create" | "improve";

export type StartCharacterAuthoringSessionInput = {
  mode: CharacterAuthoringMode;
  characterId?: string | null;
  name: string;
  description?: string;
  definitionMarkdown?: string;
  notesMarkdown?: string;
  iconFilePath?: string;
  theme?: Partial<CharacterTheme>;
  userInstruction?: string;
  provider?: string;
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
