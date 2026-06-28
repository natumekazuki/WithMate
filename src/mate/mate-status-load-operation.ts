import type { WithMateWindowApi } from "../withmate-window-api.js";
import type { MateProfile, MateStorageState } from "./mate-state.js";

export type MateStatusLoadApi = Pick<WithMateWindowApi, "getMateState" | "getMateProfile">;

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
