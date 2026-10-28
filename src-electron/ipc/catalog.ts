import type { ModelCatalogRequest } from "../../src-shared/settings/model-catalog.js";
import { WITHMATE_GET_MODEL_CATALOG_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type {
  IpcHandleRegistrar,
  MainIpcCatalogDeps,
  MainIpcEventWindowDeps,
  MainIpcHomeWindowDeps,
} from "./contracts.js";

export type MainIpcCatalogServiceDeps = Pick<MainIpcCatalogDeps, "getModelCatalog">;

export function createCatalogIpcDeps(
  services: MainIpcCatalogServiceDeps,
  context: MainIpcEventWindowDeps & MainIpcHomeWindowDeps,
): MainIpcCatalogDeps {
  return { ...context, ...services };
}

export function registerCatalogHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcCatalogDeps,
): void {
  ipcMain.handle(
    WITHMATE_GET_MODEL_CATALOG_CHANNEL,
    (_event, request?: ModelCatalogRequest) => deps.getModelCatalog(request),
  );
}
