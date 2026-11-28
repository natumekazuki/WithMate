import { installRendererErrorLogging } from "./renderer-error-logging.js";
import type { IpcRendererLike } from "./ipc.js";
import { createAuxiliaryApi } from "./auxiliary-api.js";
import { createCatalogApi, createWindowApi } from "./navigation-api.js";
import {
  createPickerApi,
  createPromptTemplateApi,
} from "./template-picker-api.js";
import { createObservabilityApi } from "./observability-api.js";
import { createSessionApi } from "./session-api.js";
import { createSubscriptionApi } from "./subscription-api.js";
import {
  createCharacterApi,
  createMateApi,
  createSettingsApi,
} from "./profile-api.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { createTerminalApi } from "./terminal-api.js";
import { createHtmlPreviewApi } from "./html-preview-api.js";
import { createCoordinationApi } from "./coordination-api.js";
import { createSessionExecutionApi } from "./session-execution-api.js";

/** 機能ごとの IPC 窓口を合成し、renderer のエラー転送も登録する。Electron 固有の File 判定は別で接続する。 */
export function createWithMateWindowApi(
  ipcRenderer: IpcRendererLike,
  platform: NodeJS.Platform = process.platform,
): Omit<WithMateWindowApi, "isClipboardFileBacked"> {
  installRendererErrorLogging(ipcRenderer);
  return {
    ...createWindowApi(ipcRenderer),
    ...createCatalogApi(ipcRenderer),
    ...createSessionApi(ipcRenderer, platform),
    ...createAuxiliaryApi(ipcRenderer),
    ...createObservabilityApi(ipcRenderer),
    ...createSettingsApi(ipcRenderer),
    ...createPromptTemplateApi(ipcRenderer),
    ...createPickerApi(ipcRenderer),
    ...createSubscriptionApi(ipcRenderer),
    ...createMateApi(ipcRenderer),
    ...createCharacterApi(ipcRenderer),
    ...createTerminalApi(ipcRenderer),
    ...createHtmlPreviewApi(ipcRenderer),
    ...createCoordinationApi(ipcRenderer),
    ...createSessionExecutionApi(ipcRenderer),
  };
}
