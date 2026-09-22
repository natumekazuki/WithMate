import { contextBridge, ipcRenderer } from "electron";

import { createWithMateWindowApi } from "./preload/preload-api.js";

contextBridge.exposeInMainWorld("withmate", createWithMateWindowApi(ipcRenderer));
