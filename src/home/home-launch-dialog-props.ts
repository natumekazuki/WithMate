import type { HomeLaunchDialogProps } from "./HomeLaunchDialog.js";
import type { HomeLaunchProjection } from "./home-launch-projection.js";
import type { HomeLaunchDraft } from "./home-launch-state.js";

type HomeLaunchDialogPropsInput = {
  draft: HomeLaunchDraft;
  projection: HomeLaunchProjection;
  canUsePrimaryFeatures: boolean;
  launchFeedback: string;
  launchStarting: boolean;
  onClose: () => void;
  onChangeTitle: (value: string) => void;
  onChangeWorkspacePath: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectSessionFolder: () => void;
  onSelectProvider: (providerId: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onSelectRandomCharacter: () => void;
  onStartSession: () => void;
};

export function buildHomeLaunchDialogProps({
  draft,
  projection,
  canUsePrimaryFeatures,
  launchFeedback,
  launchStarting,
  onClose,
  onChangeTitle,
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
    sessionFolderSelected: projection.sessionFolderSelected,
    launchWorkspacePathLabel: projection.launchWorkspacePathLabel,
    workspacePathInput: projection.workspacePathInput,
    workspaceValidation: projection.workspaceValidation,
    workspaceValidationMessage: projection.workspaceValidationMessage,
    enabledLaunchProviders: projection.enabledLaunchProviders,
    selectedLaunchProviderId: projection.selectedLaunchProvider?.id ?? null,
    characterOptions: projection.characterOptions,
    selectedCharacterId: projection.selectedCharacter?.id ?? null,
    randomCharacterSelected: projection.randomCharacterSelected,
    charactersLoaded: projection.charactersLoaded,
    canStartSession: projection.canStartSession && canUsePrimaryFeatures,
    launchFeedback,
    launchStarting,
    onClose,
    onChangeTitle,
    onChangeWorkspacePath,
    onBrowseWorkspace,
    onSelectSessionFolder,
    onSelectProvider,
    onSelectCharacter,
    onSelectRandomCharacter,
    onStartSession,
  };
}
