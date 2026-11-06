import type { HomeLaunchDialogProps } from "./HomeLaunchDialog.js";
import type { HomeLaunchProjection } from "./home-launch-projection.js";
import type { HomeLaunchDraft } from "./home-launch-state.js";

type HomeLaunchDialogPropsInput = {
  draft: HomeLaunchDraft;
  projection: HomeLaunchProjection;
  canUsePrimaryFeatures: boolean;
  launchFeedback: string;
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

export function buildHomeLaunchDialogProps({
  draft,
  projection,
  canUsePrimaryFeatures,
  launchFeedback,
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
