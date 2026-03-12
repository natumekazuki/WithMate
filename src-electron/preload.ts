import { contextBridge, ipcRenderer } from "electron";

import { WITHMATE_OPEN_SESSION_CHANNEL, type WithMateWindowApi } from "../src/withmate-window.js";

const withmateApi: WithMateWindowApi = {
  openSession(sessionId: string) {
    return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_CHANNEL, sessionId);
  },
};

contextBridge.exposeInMainWorld("withmate", withmateApi);
