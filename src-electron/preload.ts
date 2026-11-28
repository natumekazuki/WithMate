import { contextBridge, ipcRenderer, webUtils } from "electron";

import { createWithMateWindowApi } from "./preload/preload-api.js";
import type { WithMateWindowApi } from "../src-shared/ipc/withmate-window-api.js";

contextBridge.exposeInMainWorld("withmate", {
  ...createWithMateWindowApi(ipcRenderer),
  /** Electron が File のローカルパスを取得できるか判定する。パスそのものは公開しない。 */
  isClipboardFileBacked: (file) => webUtils.getPathForFile(file as File) !== "",
} satisfies WithMateWindowApi);
