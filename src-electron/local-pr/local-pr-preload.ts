import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { LOCAL_PR_CHANGED, LOCAL_PR_EXECUTE, LOCAL_PR_INSPECT_IMAGE, LOCAL_PR_PICK_ATTACHMENT, LOCAL_PR_READ_IMAGE_CHUNK, LOCAL_PR_SAVE_PASTED_FILE } from "../../src-shared/local-pr/local-pr-ipc.js";

// The dedicated window does not need the Session window's other preload capabilities.
contextBridge.exposeInMainWorld("withmateLocalPr", {
  execute: (operation, input) => ipcRenderer.invoke(LOCAL_PR_EXECUTE, operation, input),
  pickAttachment: (kind) => ipcRenderer.invoke(LOCAL_PR_PICK_ATTACHMENT, kind),
  savePastedFile: (request) => ipcRenderer.invoke(LOCAL_PR_SAVE_PASTED_FILE, request),
  isClipboardFileBacked: (file) => webUtils.getPathForFile(file) !== "",
  inspectImage: (target) => ipcRenderer.invoke(LOCAL_PR_INSPECT_IMAGE, { target }),
  readImageChunk: (request) => ipcRenderer.invoke(LOCAL_PR_READ_IMAGE_CHUNK, request),
  subscribeChanged(listener) {
    const onChanged = () => listener();
    ipcRenderer.on(LOCAL_PR_CHANGED, onChanged);
    return () => ipcRenderer.removeListener(LOCAL_PR_CHANGED, onChanged);
  },
} satisfies LocalPrWindowApi);
