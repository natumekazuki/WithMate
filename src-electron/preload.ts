import { contextBridge, ipcRenderer } from "electron";

import {
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_LIST_SESSIONS_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  type WithMateWindowApi,
} from "../src/withmate-window.js";

const withmateApi: WithMateWindowApi = {
  openSession(sessionId: string) {
    return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_CHANNEL, sessionId);
  },
  listSessions() {
    return ipcRenderer.invoke(WITHMATE_LIST_SESSIONS_CHANNEL);
  },
  getSession(sessionId: string) {
    return ipcRenderer.invoke(WITHMATE_GET_SESSION_CHANNEL, sessionId);
  },
  createSession(input) {
    return ipcRenderer.invoke(WITHMATE_CREATE_SESSION_CHANNEL, input);
  },
  updateSession(session) {
    return ipcRenderer.invoke(WITHMATE_UPDATE_SESSION_CHANNEL, session);
  },
  pickDirectory() {
    return ipcRenderer.invoke(WITHMATE_PICK_DIRECTORY_CHANNEL);
  },
  subscribeSessions(listener) {
    const wrapped = (_event: unknown, sessions: Awaited<ReturnType<WithMateWindowApi["listSessions"]>>) => {
      listener(sessions);
    };

    ipcRenderer.on(WITHMATE_SESSIONS_CHANGED_EVENT, wrapped);
    return () => {
      ipcRenderer.removeListener(WITHMATE_SESSIONS_CHANGED_EVENT, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("withmate", withmateApi);
