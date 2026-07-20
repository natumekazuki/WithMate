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
  onSelectMode: (mode: HomeLaunchDraft["mode"]) => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectProvider: (providerId: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onSelectRandomCharacter: () => void;
  onStartSession: (mode: HomeLaunchDraft["mode"]) => void;
};

export function buildHomeLaunchDialogProps({
  draft,
  projection,
  canUsePrimaryFeatures,
  launchFeedback,
  launchStarting,
  onClose,
  onSelectMode,
  onChangeTitle,
  onBrowseWorkspace,
  onSelectProvider,
  onSelectCharacter,
  onSelectRandomCharacter,
  onStartSession,
}: HomeLaunchDialogPropsInput): HomeLaunchDialogProps {
  return {
    open: draft.open,
    mode: draft.mode,
    title: draft.title,
    workspace: draft.workspace,
    launchWorkspacePathLabel: projection.launchWorkspacePathLabel,
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
    onSelectMode,
    onChangeTitle,
    onBrowseWorkspace,
    onSelectProvider,
    onSelectCharacter,
    onSelectRandomCharacter,
    onStartSession,
  };
}
