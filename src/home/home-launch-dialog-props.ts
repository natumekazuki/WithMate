import type { HomeLaunchDialogProps } from "./HomeLaunchDialog.js";
import type { HomeLaunchProjection } from "./home-launch-projection.js";
import type { HomeLaunchDraft } from "./home-launch-state.js";

/** 起動欄の下書き・表示用の判定・機能の利用可否と、各入力や開始の操作。 */
type HomeLaunchDialogPropsInput = {
  draft: HomeLaunchDraft;
  projection: HomeLaunchProjection;
  canUsePrimaryFeatures: boolean;
  launchFeedback: string;
  randomLaunchReadiness: HomeLaunchDialogProps["randomLaunchReadiness"];
  launchCreationError?: string;
  launchStarting: boolean;
  onClose: () => void;
  onChangeTitle: (value: string) => void;
  onSelectRole: (role: HomeLaunchDraft["sessionRole"]) => void;
  onChangeWorkspacePath: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectSessionFolder: () => void;
  onSelectProvider: (providerId: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onSelectRandomCharacter: () => void;
  onStartSession: () => void;
};

/** 起動欄の表示データをそろえ、起動条件だけでなく Home 側の機能利用可否も開始ボタンへ反映する。 */
export function buildHomeLaunchDialogProps({
  draft,
  projection,
  canUsePrimaryFeatures,
  launchFeedback,
  randomLaunchReadiness,
  launchCreationError,
  launchStarting,
  onClose,
  onChangeTitle,
  onSelectRole,
  onChangeWorkspacePath,
  onBrowseWorkspace,
  onSelectSessionFolder,
  onSelectProvider,
  onSelectCharacter,
  onSelectRandomCharacter,
  onStartSession,
}: HomeLaunchDialogPropsInput): HomeLaunchDialogProps {
  return {
    open: draft.open,
    title: draft.title,
    sessionRole: draft.sessionRole,
    sessionFolderSelected: projection.sessionFolderSelected,
    workspacePathInput: projection.workspacePathInput,
    workspaceValidation: projection.workspaceValidation,
    workspaceValidationMessage: projection.workspaceValidationMessage,
    enabledLaunchProviders: projection.enabledLaunchProviders,
    providerLoadStatus: projection.providerLoadStatus,
    providerLoadError: projection.providerLoadError,
    selectedLaunchProviderId: projection.selectedLaunchProvider?.id ?? null,
    characterOptions: projection.characterOptions,
    selectedCharacterId: projection.selectedCharacter?.id ?? null,
    randomCharacterSelected: projection.randomCharacterSelected,
    charactersLoaded: projection.charactersLoaded,
    characterLoadStatus: projection.characterLoadStatus,
    canStartSession: projection.canStartSession && canUsePrimaryFeatures,
    launchFeedback,
    randomLaunchReadiness,
    launchCreationError,
    launchStarting,
    onClose,
    onChangeTitle,
    onSelectRole,
    onChangeWorkspacePath,
    onBrowseWorkspace,
    onSelectSessionFolder,
    onSelectProvider,
    onSelectCharacter,
    onSelectRandomCharacter,
    onStartSession,
  };
}
