import { installRendererErrorLogging } from "./renderer-error-logging.js";
import type { IpcRendererLike } from "./ipc.js";
import { createAuxiliaryApi } from "./auxiliary-api.js";
import { createCatalogApi, createWindowApi } from "./navigation-api.js";
import {
  createMemoryV6ReviewApi,
  createPickerApi,
  createPromptTemplateApi,
} from "./memory-api.js";
import { createObservabilityApi } from "./observability-api.js";
import { createSessionApi } from "./session-api.js";
import { createSubscriptionApi } from "./subscription-api.js";
import {
  createCharacterApi,
  createMateApi,
  createSettingsApi,
} from "./profile-api.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

export function createWithMateWindowApi(
  ipcRenderer: IpcRendererLike,
  platform: NodeJS.Platform = process.platform,
): WithMateWindowApi {
  installRendererErrorLogging(ipcRenderer);
  return {
    ...createWindowApi(ipcRenderer),
    ...createMemoryV6ReviewApi(ipcRenderer),
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
  };
}
