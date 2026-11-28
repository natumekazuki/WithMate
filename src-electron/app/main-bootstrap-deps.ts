import type { IpcMain } from "electron";

import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppBootStatus } from "../../src-shared/window/app-boot-state.js";
import {
  createMainIpcRegistrationDeps,
  type CreateMainIpcRegistrationDepsArgs,
} from "./main-ipc-deps.js";
import type { registerMainIpcHandlers } from "../ipc/register-main-ipc.js";
import type { MainBootstrapService } from "./main-bootstrap-service.js";

/** Main の起動処理に、ストア初期化、復旧、IPC 登録、通知を接続する入力。 */
type CreateMainBootstrapDepsArgs = {
  ipcMain: IpcMain;
  registerMainIpcHandlers: typeof registerMainIpcHandlers;
  /** 永続ストアを開き、起動後に通知するモデル一覧のスナップショットを得る。 */
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  /** 初期化したストアを使い、前回の終了で中断した Session を復旧する。 */
  recoverInterruptedSessions(): Promise<void>;
  /** 起動時に確定したモデル一覧を購読側へ通知する。 */
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  getMateState?: () => MateStorageState | Promise<MateStorageState>;
  onBootStatus?: (status: AppBootStatus) => void;
  ipcRegistration: CreateMainIpcRegistrationDepsArgs;
};

/** IPC 依存の組み立てを登録時まで遅らせ、Mate 状態の既定の取得先を IPC 依存から引き継ぐ。 */
export function createMainBootstrapDeps(
  args: CreateMainBootstrapDepsArgs,
): ConstructorParameters<typeof MainBootstrapService>[0] {
  return {
    initializePersistentStores: args.initializePersistentStores,
    recoverInterruptedSessions: args.recoverInterruptedSessions,
    getMateState: args.getMateState ?? args.ipcRegistration.mate.getMateState,
    onBootStatus: args.onBootStatus,
    /** 起動処理が登録段階に達した時点で、機能ごとの依存を組み立てて IPC を登録する。 */
    registerIpcHandlers: () => {
      args.registerMainIpcHandlers(
        args.ipcMain,
        createMainIpcRegistrationDeps(args.ipcRegistration),
      );
    },
    broadcastModelCatalog: args.broadcastModelCatalog,
  };
}
