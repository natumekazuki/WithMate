import {
  loadMateStatusSnapshot,
  type MateStatusLoadApi,
} from "./mate-status-load-operation.js";
import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import type { MateAvatarAction } from "./MateSetupPanel.js";

/** 読み取り結果を Home の保存状態、プロフィール、表示名、アバター操作へ反映する更新口。 */
type MateStatusRefreshersContext = {
  setMateState: (state: MateStorageState) => void;
  setMateProfile: (profile: MateProfile | null) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateAvatarAction: (action: MateAvatarAction) => void;
};

/** 読み取った保存状態を返し、有効な取得結果だけを画面へ反映する更新操作。 */
export type MateStatusRefreshers = {
  refreshMateStatus: (
    api: MateStatusLoadApi,
    options?: { isActive?: () => boolean },
  ) => Promise<MateStorageState>;
};

/** 呼び出し元の状態更新口に、Mate の取得結果を反映する操作を組み立てる。 */
export function buildMateStatusRefreshers({
  setMateState,
  setMateProfile,
  setMateDisplayName,
  setMateAvatarAction,
}: MateStatusRefreshersContext): MateStatusRefreshers {
  /** 有効な結果だけを反映し、未作成や利用不可の場合は以前のプロフィール表示を消す。 */
  const refreshMateStatus: MateStatusRefreshers["refreshMateStatus"] = async (
    api,
    options,
  ) => {
    const isActive = options?.isActive ?? (() => true);
    const result = await loadMateStatusSnapshot({ api, isActive });
    if (result.status === "stale" || !isActive()) {
      return result.mateState;
    }

    if (
      result.mateState === "not_created" ||
      result.mateState === "profile_unavailable"
    ) {
      setMateState(result.mateState);
      setMateProfile(null);
      setMateDisplayName("");
      setMateAvatarAction(null);
      return result.mateState;
    }

    setMateState(result.mateState);
    setMateProfile(result.mateProfile);
    setMateDisplayName(result.mateProfile?.displayName ?? "");
    return result.mateState;
  };

  return {
    refreshMateStatus,
  };
}
