import { contextBridge, ipcRenderer } from "electron";

import { createWithMateWindowApi } from "./preload-api.js";

contextBridge.exposeInMainWorld("withmate", createWithMateWindowApi(ipcRenderer));
