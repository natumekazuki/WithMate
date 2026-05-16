import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

export type HomeMateProfileApi = Pick<
  WithMateWindowApi,
  | "createMate"
  | "updateMate"
  | "getMateState"
  | "getMateProfile"
  | "pickImageFile"
  | "setMateAvatar"
>;

export type SaveHomeMateProfileInput = {
  api: HomeMateProfileApi;
  displayName: string;
  mateState: MateStorageState | null;
  setMateState: (state: MateStorageState) => void;
  setMateProfile: (profile: MateProfile | null) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateCreationFeedback: (message: string) => void;
  setMateProfileEditorOpen: (open: boolean) => void;
  setMateCreating: (creating: boolean) => void;
  setLaunchFeedback: (message: string) => void;
  hydrateHomeData: () => Promise<void>;
  clearMateGrowthViewState: () => void;
};

export async function saveHomeMateProfile(input: SaveHomeMateProfileInput): Promise<void> {
  const displayName = input.displayName.trim();
  if (!displayName) {
    input.setMateCreationFeedback("displayName を入力してね。");
    return;
  }

  const creatingMate = input.mateState === "not_created";
  input.setMateCreationFeedback(creatingMate ? "Mate 作成中..." : "Mate 保存中...");
  input.setMateCreating(true);
  try {
    const savedProfile = creatingMate
      ? await input.api.createMate({ displayName })
      : await input.api.updateMate({ displayName });
    let nextMateState: MateStorageState = "active";
    let nextMateProfile = savedProfile as MateProfile | null;

    try {
      nextMateState = await input.api.getMateState();
      if (nextMateState !== "not_created") {
        const loadedProfile = await input.api.getMateProfile();
        if (loadedProfile) {
          nextMateProfile = loadedProfile;
        }
      }
    } catch {
    }

    input.setMateState(nextMateState);
    input.setMateProfile(nextMateProfile);
    input.setMateDisplayName(nextMateProfile?.displayName ?? "");
    input.setMateCreationFeedback(creatingMate ? "" : "Mate を保存したよ。");
    input.setMateProfileEditorOpen(false);

    if (nextMateState !== "not_created") {
      try {
        await input.hydrateHomeData();
      } catch (error) {
        input.setLaunchFeedback(error instanceof Error ? error.message : "Home の読み込みに失敗したよ。");
      }
    } else {
      input.clearMateGrowthViewState();
    }
  } catch (error) {
    input.setMateCreationFeedback(error instanceof Error ? error.message : "Mate の保存に失敗したよ。");
  } finally {
    input.setMateCreating(false);
  }
}

export type UpdateHomeMateAvatarInput = {
  api: HomeMateProfileApi;
  mateState: MateStorageState | null;
  currentAvatarFilePath: string | null;
  setMateProfile: (profile: MateProfile) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateCreationFeedback: (message: string) => void;
  setMateAvatarUpdating: (updating: boolean) => void;
  setLaunchFeedback: (message: string) => void;
  refreshSessionSummaries: () => Promise<void>;
};

export async function selectHomeMateAvatar(input: UpdateHomeMateAvatarInput): Promise<void> {
  if (input.mateState === "not_created") {
    input.setMateCreationFeedback("Mate を作成してからアイコンを設定してね。");
    return;
  }

  input.setMateAvatarUpdating(true);
  try {
    input.setMateCreationFeedback("");
    const selectedPath = await input.api.pickImageFile(input.currentAvatarFilePath);
    if (!selectedPath) {
      return;
    }

    input.setMateCreationFeedback("Mate のアイコンを更新中...");
    await applyHomeMateAvatarUpdate(input, selectedPath, "Mate のアイコンを更新したよ。");
  } catch (error) {
    input.setMateCreationFeedback(error instanceof Error ? error.message : "Mate のアイコン更新に失敗したよ。");
  } finally {
    input.setMateAvatarUpdating(false);
  }
}

export async function clearHomeMateAvatar(input: UpdateHomeMateAvatarInput): Promise<void> {
  if (input.mateState === "not_created") {
    input.setMateCreationFeedback("Mate を作成してからアイコンを設定してね。");
    return;
  }

  input.setMateAvatarUpdating(true);
  input.setMateCreationFeedback("Mate のアイコンを解除中...");
  try {
    await applyHomeMateAvatarUpdate(input, null, "Mate のアイコンを解除したよ。");
  } catch (error) {
    input.setMateCreationFeedback(error instanceof Error ? error.message : "Mate のアイコン解除に失敗したよ。");
  } finally {
    input.setMateAvatarUpdating(false);
  }
}

async function applyHomeMateAvatarUpdate(
  input: UpdateHomeMateAvatarInput,
  avatarFilePath: string | null,
  successMessage: string,
): Promise<void> {
  const nextMateProfile = await input.api.setMateAvatar({ avatarFilePath });
  input.setMateProfile(nextMateProfile);
  input.setMateDisplayName(nextMateProfile.displayName);
  input.setMateCreationFeedback(successMessage);

  try {
    await input.refreshSessionSummaries();
  } catch (error) {
    input.setLaunchFeedback(error instanceof Error ? error.message : "Home の読み込みに失敗したよ。");
  }
}
