import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";

/** 保存状態とプロフィールの読み取りに必要な Window API に絞る。 */
export type MateStatusLoadApi = Pick<
  WithMateWindowApi,
  "getMateState" | "getMateProfile"
>;

/** 反映可能な読み取り結果と、呼び出しの有効期間が切れた途中結果を区別する。 */
export type MateStatusLoadResult =
  | {
      status: "ready";
      mateState: MateStorageState;
      mateProfile: MateProfile | null;
    }
  | {
      status: "stale";
      mateState: MateStorageState;
    };

/** 保存状態を先に読み、未作成・利用不可・取得が無効になった場合はプロフィールの取得に進まない。 */
export async function loadMateStatusSnapshot({
  api,
  isActive = () => true,
}: {
  api: MateStatusLoadApi;
  isActive?: () => boolean;
}): Promise<MateStatusLoadResult> {
  const mateState = await api.getMateState();
  if (!isActive()) {
    return { status: "stale", mateState };
  }

  if (mateState === "not_created" || mateState === "profile_unavailable") {
    return { status: "ready", mateState, mateProfile: null };
  }

  const mateProfile = await api.getMateProfile();
  if (!isActive()) {
    return { status: "stale", mateState };
  }

  return { status: "ready", mateState, mateProfile };
}
