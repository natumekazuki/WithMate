import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { MateAvatarAction } from "../mate/MateSetupPanel.js";
import {
  clearHomeMateAvatar,
  saveHomeMateProfile,
  selectHomeMateAvatar,
} from "./home-mate-profile-actions.js";

/** 操作時の API と、現在のプロフィール・入力・操作結果を Home で更新する接続先。 */
type HomeMateProfileHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  mateDisplayName: string;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  setMateState: (state: MateStorageState) => void;
  setMateProfile: (profile: MateProfile | null) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateCreationFeedback: (message: string) => void;
  setMateProfileEditorOpen: (open: boolean) => void;
  setMateCreating: (creating: boolean) => void;
  setMateAvatarAction: (action: MateAvatarAction) => void;
  setLaunchFeedback: (message: string) => void;
  refreshSessionSummaries: () => Promise<void>;
};

/** プロフィールの入力・保存・開閉と、アバター操作を画面から実行する入口。 */
export type HomeMateProfileHandlers = {
  onChangeDisplayName: (value: string) => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
  onSelectAvatar: () => void;
  onClearAvatar: () => void;
  onOpenProfileEditor: () => void;
};

/** プロフィール編集の操作を現在の入力と保存状態に結び付け、操作時に API の有無を確認する。 */
export function buildHomeMateProfileHandlers({
  getApi,
  mateDisplayName,
  mateState,
  mateProfile,
  setMateState,
  setMateProfile,
  setMateDisplayName,
  setMateCreationFeedback,
  setMateProfileEditorOpen,
  setMateCreating,
  setMateAvatarAction,
  setLaunchFeedback,
  refreshSessionSummaries: refreshSessionSummariesBounded,
}: HomeMateProfileHandlersContext): HomeMateProfileHandlers {
  /** アバターの変更後に Home がすでに持つ範囲の要約だけを再取得する。 */
  const refreshSessionSummaries = async (_api: WithMateWindowApi) =>
    refreshSessionSummariesBounded();

  return {
    /** 下書きの名前を更新し、前の入力のフィードバックを消す。 */
    onChangeDisplayName: (value) => {
      setMateDisplayName(value);
      setMateCreationFeedback("");
    },
    /** API が利用可能なら表示名の保存を開始し、利用できなければフォーム内に理由を出す。 */
    onSubmit: () => {
      const api = getApi();
      if (!api) {
        setMateCreationFeedback("Mate API が利用できないよ。");
        return;
      }

      void saveHomeMateProfile({
        api,
        displayName: mateDisplayName,
        mateState,
        setMateState,
        setMateProfile,
        setMateDisplayName,
        setMateCreationFeedback,
        setMateProfileEditorOpen,
        setMateCreating,
        setLaunchFeedback,
        /** プロフィールの保存後に Home の Session 要約を再取得する。 */
        hydrateHomeData: async () => {
          await refreshSessionSummariesBounded();
        },
      });
    },
    /** 保存を行わず、プロフィール編集を閉じる。 */
    onCancelEdit: () => setMateProfileEditorOpen(false),
    /** API が利用可能なら、現在のパスを初期値としてアバター選択を開く。 */
    onSelectAvatar: () => {
      const api = getApi();
      if (!api) {
        setMateCreationFeedback("Mate API が利用できないよ。");
        return;
      }

      void selectHomeMateAvatar({
        api,
        mateState,
        currentAvatarFilePath: mateProfile?.avatarFilePath ?? null,
        setMateProfile,
        setMateDisplayName,
        setMateCreationFeedback,
        setMateAvatarAction,
        setLaunchFeedback,
        /** アバターの置き換え後に、表示中の要約を更新する。 */
        refreshSessionSummaries: async () => {
          await refreshSessionSummaries(api);
        },
      });
    },
    /** API が利用可能な場合だけ、現在のアバターを解除する操作を開始する。 */
    onClearAvatar: () => {
      const api = getApi();
      if (!api) {
        setMateCreationFeedback("Mate API が利用できないよ。");
        return;
      }

      void clearHomeMateAvatar({
        api,
        mateState,
        currentAvatarFilePath: mateProfile?.avatarFilePath ?? null,
        setMateProfile,
        setMateDisplayName,
        setMateCreationFeedback,
        setMateAvatarAction,
        setLaunchFeedback,
        /** アバター解除後のプロフィールを、表示中の要約にも取り込む。 */
        refreshSessionSummaries: async () => {
          await refreshSessionSummaries(api);
        },
      });
    },
    /** 利用不可の場合は理由だけを通知し、開ける場合は保存済みの名前で入力を初期化する。 */
    onOpenProfileEditor: () => {
      if (mateState === "profile_unavailable") {
        setMateCreationFeedback(
          "V6 Memory foundation では Mate Profile はまだ利用できません。",
        );
        return;
      }
      setMateDisplayName(mateProfile?.displayName ?? "");
      setMateCreationFeedback("");
      setMateProfileEditorOpen(true);
    },
  };
}
