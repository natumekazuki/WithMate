import type { MateProfile, MateStorageState } from "./mate-state.js";
import type { HomeMateSetupPanelProps } from "./MateSetupPanel.js";

export type HomeMateSetupContentInput = {
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  mateDisplayName: string;
  mateCreating: boolean;
  mateAvatarUpdating: boolean;
  mateCreationFeedback: string;
  onChangeDisplayName: (value: string) => void;
  onSubmit: () => void;
  onOpenSettings: () => void;
  onCancelEdit: () => void;
  onSelectAvatar: () => void;
  onClearAvatar: () => void;
};

export function buildHomeMateSetupContentProps({
  mateState,
  mateProfile,
  mateDisplayName,
  mateCreating,
  mateAvatarUpdating,
  mateCreationFeedback,
  onChangeDisplayName,
  onSubmit,
  onOpenSettings,
  onCancelEdit,
  onSelectAvatar,
  onClearAvatar,
}: HomeMateSetupContentInput): HomeMateSetupPanelProps {
  const isMateNotCreated = mateState === "not_created";
  const isMateProfileUnavailable = mateState === "profile_unavailable";

  return {
    mode: isMateProfileUnavailable ? "unavailable" : isMateNotCreated ? "create" : "edit",
    displayName: mateDisplayName,
    creating: mateCreating,
    feedback: mateCreationFeedback,
    onChangeDisplayName,
    onSubmit,
    onOpenSettings,
    onCancel: isMateNotCreated || isMateProfileUnavailable ? undefined : onCancelEdit,
    mateDisplayName: mateProfile?.displayName ?? null,
    mateAvatarFilePath: mateProfile?.avatarFilePath ?? "",
    avatarUpdating: mateAvatarUpdating,
    onSelectAvatar: isMateNotCreated || isMateProfileUnavailable ? undefined : onSelectAvatar,
    onClearAvatar: isMateNotCreated || isMateProfileUnavailable ? undefined : onClearAvatar,
  };
}
