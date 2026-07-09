import type { AuxiliarySession } from "./auxiliary-session-state.js";
import {
  buildSkillPromptInsertionState,
  type SkillPromptInsertionState,
} from "./session-composer-selection.js";

export async function runAuxiliarySkillPromptInsertionOperation(input: {
  activeSession: Pick<AuxiliarySession, "provider" | "composerDraft"> | null;
  skillName: string;
  applyUiState: (state: SkillPromptInsertionState) => void;
  updateDraft: (draft: string) => Promise<void>;
  afterDraftUpdated?: (state: SkillPromptInsertionState) => void;
}): Promise<SkillPromptInsertionState | null> {
  if (!input.activeSession) {
    return null;
  }

  const nextState = buildSkillPromptInsertionState(
    input.activeSession.provider,
    input.skillName,
    input.activeSession.composerDraft,
  );

  input.applyUiState(nextState);
  await input.updateDraft(nextState.draft);
  input.afterDraftUpdated?.(nextState);
  return nextState;
}
