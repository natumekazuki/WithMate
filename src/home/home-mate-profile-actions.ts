import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { MateAvatarAction } from "../mate/MateSetupPanel.js";

/** Mate のプロフィールとアバターを保存し、保存後の状態や画像選択を取得する API。 */
export type HomeMateProfileApi = Pick<
  WithMateWindowApi,
  | "createMate"
  | "updateMate"
  | "getMateState"
  | "getMateProfile"
  | "pickImageFile"
  | "setMateAvatar"
>;

/** 保存時の入力とストレージ状態、および保存値・通知・Home の再取得を反映する接続先。 */
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
  clearMateGrowthViewState?: () => void;
};

/** 表示名を確認して作成または更新し、成功後の再取得に失敗しても取得済みの保存結果を使う。 */
export async function saveHomeMateProfile(
  input: SaveHomeMateProfileInput,
): Promise<void> {
  if (input.mateState === "profile_unavailable") {
    input.setMateCreationFeedback(
      "V6 Memory foundation では Mate Profile はまだ利用できません。",
    );
    return;
  }

  const displayName = input.displayName.trim();
  if (!displayName) {
    input.setMateCreationFeedback("displayName を入力してね。");
    return;
  }

  const creatingMate = input.mateState === "not_created";
  input.setMateCreationFeedback(
    creatingMate ? "Mate 作成中..." : "Mate 保存中...",
  );
  input.setMateCreating(true);
  try {
    const savedProfile = creatingMate
      ? await input.api.createMate({ displayName })
      : await input.api.updateMate({ displayName });
    let nextMateState: MateStorageState = "active";
    let nextMateProfile = savedProfile as MateProfile | null;

    try {
      nextMateState = await input.api.getMateState();
      if (
        nextMateState !== "not_created" &&
        nextMateState !== "profile_unavailable"
      ) {
        const loadedProfile = await input.api.getMateProfile();
        if (loadedProfile) {
          nextMateProfile = loadedProfile;
        }
      }
    } catch {}

    input.setMateState(nextMateState);
    input.setMateProfile(nextMateProfile);
    input.setMateDisplayName(nextMateProfile?.displayName ?? "");
    input.setMateCreationFeedback(creatingMate ? "" : "Mate を保存したよ。");
    input.setMateProfileEditorOpen(false);

    if (
      nextMateState !== "not_created" &&
      nextMateState !== "profile_unavailable"
    ) {
      try {
        await input.hydrateHomeData();
      } catch (error) {
        input.setLaunchFeedback(
          error instanceof Error
            ? error.message
            : "Home の読み込みに失敗したよ。",
        );
      }
    } else {
      input.clearMateGrowthViewState?.();
    }
  } catch (error) {
    input.setMateCreationFeedback(
      error instanceof Error ? error.message : "Mate の保存に失敗したよ。",
    );
  } finally {
    input.setMateCreating(false);
  }
}

/** アバターを変更する対象の状態と現在パス、保存結果や関連要約を反映する接続先。 */
export type UpdateHomeMateAvatarInput = {
  api: HomeMateProfileApi;
  mateState: MateStorageState | null;
  currentAvatarFilePath: string | null;
  setMateProfile: (profile: MateProfile) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateCreationFeedback: (message: string) => void;
  setMateAvatarAction: (action: MateAvatarAction) => void;
  setLaunchFeedback: (message: string) => void;
  refreshSessionSummaries: () => Promise<void>;
};

/** 利用可能な既存プロフィールで画像を選択して保存する。選択を取り消した場合は保存しない。 */
export async function selectHomeMateAvatar(
  input: UpdateHomeMateAvatarInput,
): Promise<void> {
  if (input.mateState === "profile_unavailable") {
    input.setMateCreationFeedback(
      "V6 Memory foundation では Mate Profile はまだ利用できません。",
    );
    return;
  }
  if (input.mateState === "not_created") {
    input.setMateCreationFeedback("Mate を作成してからアイコンを設定してね。");
    return;
  }

  input.setMateAvatarAction("select");
  try {
    input.setMateCreationFeedback("");
    const selectedPath = await input.api.pickImageFile(
      input.currentAvatarFilePath,
    );
    if (!selectedPath) {
      return;
    }

    input.setMateCreationFeedback("Mate のアイコンを更新中...");
    await applyHomeMateAvatarUpdate(
      input,
      selectedPath,
      "Mate のアイコンを更新したよ。",
    );
  } catch (error) {
    input.setMateCreationFeedback(
      error instanceof Error
        ? error.message
        : "Mate のアイコン更新に失敗したよ。",
    );
  } finally {
    input.setMateAvatarAction(null);
  }
}

/** 利用可能な既存プロフィールのアバター参照を解除し、終了時には操作中の表示を戻す。 */
export async function clearHomeMateAvatar(
  input: UpdateHomeMateAvatarInput,
): Promise<void> {
  if (input.mateState === "profile_unavailable") {
    input.setMateCreationFeedback(
      "V6 Memory foundation では Mate Profile はまだ利用できません。",
    );
    return;
  }
  if (input.mateState === "not_created") {
    input.setMateCreationFeedback("Mate を作成してからアイコンを設定してね。");
    return;
  }

  input.setMateAvatarAction("clear");
  input.setMateCreationFeedback("Mate のアイコンを解除中...");
  try {
    await applyHomeMateAvatarUpdate(
      input,
      null,
      "Mate のアイコンを解除したよ。",
    );
  } catch (error) {
    input.setMateCreationFeedback(
      error instanceof Error
        ? error.message
        : "Mate のアイコン解除に失敗したよ。",
    );
  } finally {
    input.setMateAvatarAction(null);
  }
}

/** 保存されたプロフィールを先に反映し、その後の要約再取得の失敗は別の Home 通知として扱う。 */
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
    input.setLaunchFeedback(
      error instanceof Error ? error.message : "Home の読み込みに失敗したよ。",
    );
  }
}
