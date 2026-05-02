import type { BrowserWindow, IpcMain } from "electron";

import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
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
  refreshCharactersFromStorage(): Promise<void>;
  createHomeWindow(): Promise<BrowserWindow>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  ipcRegistration: CreateMainIpcRegistrationDepsArgs;
};

export function createMainBootstrapDeps(
  args: CreateMainBootstrapDepsArgs,
): ConstructorParameters<typeof MainBootstrapService>[0] {
  return {
    initializePersistentStores: args.initializePersistentStores,
    recoverInterruptedSessions: args.recoverInterruptedSessions,
    refreshCharactersFromStorage: args.refreshCharactersFromStorage,
    registerIpcHandlers: () => {
      args.registerMainIpcHandlers(args.ipcMain, createMainIpcRegistrationDeps(args.ipcRegistration));
    },
    createHomeWindow: async () => {
      await args.createHomeWindow();
    },
    broadcastModelCatalog: args.broadcastModelCatalog,
  };
}
