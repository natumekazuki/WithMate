import type { ModelCatalogRequest } from "../../src-shared/settings/model-catalog.js";
import { WITHMATE_GET_MODEL_CATALOG_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type {
  IpcHandleRegistrar,
  MainIpcCatalogDeps,
  MainIpcEventWindowDeps,
  MainIpcHomeWindowDeps,
} from "./contracts.js";

/** プロバイダーのモデルカタログ取得を担うサービス側の依存。 */
export type MainIpcCatalogServiceDeps = Pick<
  MainIpcCatalogDeps,
  "getModelCatalog"
>;

/** モデル取得サービスとウィンドウ解決用の共通依存を束ねる。 */
export function createCatalogIpcDeps(
  services: MainIpcCatalogServiceDeps,
  context: MainIpcEventWindowDeps & MainIpcHomeWindowDeps,
): MainIpcCatalogDeps {
  return { ...context, ...services };
}

/** 任意のカタログ要求をモデル取得サービスへ渡す IPC を登録する。この登録では呼び出し元のウィンドウ種別を限定しない。 */
export function registerCatalogHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcCatalogDeps,
): void {
  ipcMain.handle(
    WITHMATE_GET_MODEL_CATALOG_CHANNEL,
    (_event, request?: ModelCatalogRequest) => deps.getModelCatalog(request),
  );
}
