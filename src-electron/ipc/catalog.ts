import type { ModelCatalogDocument } from "../../src-shared/settings/model-catalog.js";

import {
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

import type {
  IpcHandleRegistrar,
  MainIpcCatalogDeps,
  MainIpcEventWindowDeps,
  MainIpcHomeWindowDeps,
} from "./contracts.js";
import { resolveTargetWindow } from "./shared.js";

export type MainIpcCatalogServiceDeps = Pick<
  MainIpcCatalogDeps,
  | "getModelCatalog"
  | "importModelCatalogDocument"
  | "importModelCatalogFromFile"
  | "exportModelCatalogDocument"
  | "exportModelCatalogToFile"
>;

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
    (_event, revision: number | null) => deps.getModelCatalog(revision),
  );
  ipcMain.handle(
    WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
    (_event, document: ModelCatalogDocument) =>
      deps.importModelCatalogDocument(document),
  );
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL, async (event) =>
    deps.importModelCatalogFromFile(resolveTargetWindow(event, deps)),
  );
  ipcMain.handle(
    WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
    (_event, revision: number | null) =>
      deps.exportModelCatalogDocument(revision),
  );
  ipcMain.handle(
    WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
    async (event, revision: number | null) =>
      deps.exportModelCatalogToFile(revision, resolveTargetWindow(event, deps)),
  );
}
