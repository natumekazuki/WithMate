import {
  applyAuxiliarySessionCustomAgentPatch,
  type AuxiliarySession,
} from "../../../src-shared/auxiliary/auxiliary-session-state.js";

/** 現在の Auxiliary を入力にする差分適用処理を、非同期の更新境界へ渡す。 */
type UpdateActiveAuxiliarySession = (
  recipe: (current: AuxiliarySession) => AuxiliarySession,
) => Promise<void>;

/** カスタム Agent の選択を適用できない場合、既存値と同じ場合、更新した場合を区別する。 */
export type AuxiliaryCustomAgentSelectionResult =
  "noop" | "unchanged" | "updated";

/** Copilot の Auxiliary だけを対象にし、同じ値または更新成功の場合に選択欄を閉じる。 */
export async function runAuxiliaryCustomAgentSelectionOperation(input: {
  activeSession: Pick<AuxiliarySession, "provider" | "customAgentName"> | null;
  customAgentName: string;
  updateCustomAgent: (customAgentName: string) => Promise<void>;
  closeAgentPicker: () => void;
}): Promise<AuxiliaryCustomAgentSelectionResult> {
  if (!input.activeSession || input.activeSession.provider !== "copilot") {
    return "noop";
  }

  if (input.customAgentName === input.activeSession.customAgentName) {
    input.closeAgentPicker();
    return "unchanged";
  }

  await input.updateCustomAgent(input.customAgentName);
  input.closeAgentPicker();
  return "updated";
}

/** 現在の Auxiliary にカスタム Agent と更新日時を適用し、呼び出し元の更新境界で保存する。 */
export async function runAuxiliaryCustomAgentPatchOperation(input: {
  customAgentName: string;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) =>
    applyAuxiliarySessionCustomAgentPatch(
      current,
      input.customAgentName,
      input.createTimestampLabel(),
    ),
  );
}
