import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { LOCAL_PR_CHANGED, LOCAL_PR_EXECUTE, LOCAL_PR_INSPECT_IMAGE, LOCAL_PR_PICK_ATTACHMENT, LOCAL_PR_READ_IMAGE_CHUNK, LOCAL_PR_SAVE_CLIPBOARD_IMAGE, LOCAL_PR_OPEN_ATTACHMENT } from "../../src-shared/local-pr/local-pr-ipc.js";

// 専用ウィンドウでは Session ウィンドウ向けのその他の preload 機能は不要。
contextBridge.exposeInMainWorld("withmateLocalPr", {
  execute: (operation, input) => ipcRenderer.invoke(LOCAL_PR_EXECUTE, operation, input),
  pickAttachment: () => ipcRenderer.invoke(LOCAL_PR_PICK_ATTACHMENT),
  clipboardFilePath: (file) => webUtils.getPathForFile(file),
  saveClipboardImage: (request) => ipcRenderer.invoke(LOCAL_PR_SAVE_CLIPBOARD_IMAGE, request),
  openAttachment: (target) => ipcRenderer.invoke(LOCAL_PR_OPEN_ATTACHMENT, target),
  inspectImage: (target) => ipcRenderer.invoke(LOCAL_PR_INSPECT_IMAGE, { target }),
  readImageChunk: (request) => ipcRenderer.invoke(LOCAL_PR_READ_IMAGE_CHUNK, request),
  subscribeChanged(listener) {
    const onChanged = () => listener();
    ipcRenderer.on(LOCAL_PR_CHANGED, onChanged);
    return () => ipcRenderer.removeListener(LOCAL_PR_CHANGED, onChanged);
  },
} satisfies LocalPrWindowApi);
