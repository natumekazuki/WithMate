import type {
  CreateMateInput,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../../src-shared/mate/mate-state.js";

import {
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_UPDATE_MATE_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_GET_MATE_PROFILE_CHANNEL,
  WITHMATE_RESET_MATE_CHANNEL,
  WITHMATE_SET_MATE_AVATAR_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

import type { IpcHandleRegistrar, MainIpcMateDeps } from "./contracts.js";

/** Mate の状態とプロフィールの取得、作成・更新・アバター変更・リセットをそれぞれのサービスへ委譲する IPC を登録する。 */
export function registerMateHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcMateDeps,
): void {
  ipcMain.handle(WITHMATE_GET_MATE_STATE_CHANNEL, () => deps.getMateState());
  ipcMain.handle(WITHMATE_GET_MATE_PROFILE_CHANNEL, () =>
    deps.getMateProfile(),
  );
  ipcMain.handle(
    WITHMATE_CREATE_MATE_CHANNEL,
    (_event, input: CreateMateInput) => deps.createMate(input),
  );
  ipcMain.handle(
    WITHMATE_UPDATE_MATE_CHANNEL,
    (_event, input: UpdateMateInput) => deps.updateMate(input),
  );
  ipcMain.handle(
    WITHMATE_SET_MATE_AVATAR_CHANNEL,
    (_event, input: SetMateAvatarInput) => deps.setMateAvatar(input),
  );
  ipcMain.handle(WITHMATE_RESET_MATE_CHANNEL, () => deps.resetMate());
}
