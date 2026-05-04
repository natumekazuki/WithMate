import type { BrowserWindow, IpcMain } from "electron";

import type { MateStorageState } from "../src/mate-state.js";
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
  getMateState(): MateStorageState | Promise<MateStorageState>;
  applyPendingGrowth(): Promise<unknown>;
  growthApplyIntervalMs?: number;
  createGrowthApplyTimer?: (handler: () => void, intervalMs: number) => unknown;
  clearGrowthApplyTimer?: (timer: unknown) => void;
  ipcRegistration: CreateMainIpcRegistrationDepsArgs;
};

export function createMainBootstrapDeps(
  args: CreateMainBootstrapDepsArgs,
): ConstructorParameters<typeof MainBootstrapService>[0] {
  return {
    initializePersistentStores: args.initializePersistentStores,
    recoverInterruptedSessions: args.recoverInterruptedSessions,
    refreshCharactersFromStorage: args.refreshCharactersFromStorage,
    getMateState: args.getMateState,
    applyPendingGrowth: args.applyPendingGrowth,
    growthApplyIntervalMs: args.growthApplyIntervalMs,
    createGrowthApplyTimer: args.createGrowthApplyTimer,
    clearGrowthApplyTimer: args.clearGrowthApplyTimer,
    registerIpcHandlers: () => {
      args.registerMainIpcHandlers(args.ipcMain, createMainIpcRegistrationDeps(args.ipcRegistration));
    },
    createHomeWindow: async () => {
      await args.createHomeWindow();
    },
    broadcastModelCatalog: args.broadcastModelCatalog,
  };
}
