import type { BrowserWindow, IpcMain } from "electron";

import type { MateStorageState } from "../src/mate/mate-state.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppBootStatus } from "../src/app-boot-state.js";
import {
  createMainIpcRegistrationDeps,
  type CreateMainIpcRegistrationDepsArgs,
} from "./main-ipc-deps.js";
import type { registerMainIpcHandlers } from "./main-ipc-registration.js";
import type { MainBootstrapService } from "./main-bootstrap-service.js";

type CreateMainBootstrapDepsArgs = {
  ipcMain: IpcMain;
  registerMainIpcHandlers: typeof registerMainIpcHandlers;
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  recoverInterruptedSessions(): Promise<void>;
  createHomeWindow(): Promise<BrowserWindow | null>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  getMateState?: () => MateStorageState | Promise<MateStorageState>;
  onBootStatus?: (status: AppBootStatus) => void;
  ipcRegistration: CreateMainIpcRegistrationDepsArgs;
};

export function createMainBootstrapDeps(
  args: CreateMainBootstrapDepsArgs,
): ConstructorParameters<typeof MainBootstrapService>[0] {
  return {
    initializePersistentStores: args.initializePersistentStores,
    recoverInterruptedSessions: args.recoverInterruptedSessions,
    getMateState: args.getMateState ?? args.ipcRegistration.mate.getMateState,
    onBootStatus: args.onBootStatus,
    registerIpcHandlers: () => {
      args.registerMainIpcHandlers(args.ipcMain, createMainIpcRegistrationDeps(args.ipcRegistration));
    },
    createHomeWindow: async () => {
      await args.createHomeWindow();
    },
    broadcastModelCatalog: args.broadcastModelCatalog,
  };
}
