import { contextBridge, ipcRenderer } from "electron";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { LOCAL_PR_CHANGED, LOCAL_PR_EXECUTE } from "../../src-shared/local-pr/local-pr-ipc.js";

// The dedicated window does not need the Session window's other preload capabilities.
contextBridge.exposeInMainWorld("withmateLocalPr", {
  execute: (operation, input) => ipcRenderer.invoke(LOCAL_PR_EXECUTE, operation, input),
  subscribeChanged(listener) {
    const onChanged = () => listener();
    ipcRenderer.on(LOCAL_PR_CHANGED, onChanged);
    return () => ipcRenderer.removeListener(LOCAL_PR_CHANGED, onChanged);
  },
} satisfies LocalPrWindowApi);
