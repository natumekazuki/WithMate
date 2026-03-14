import { contextBridge, ipcRenderer } from "electron";

import {
  WITHMATE_CHARACTERS_CHANGED_EVENT,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_CHARACTER_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_SESSIONS_CHANNEL,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  type WithMateWindowApi,
} from "../src/withmate-window.js";

const withmateApi: WithMateWindowApi = {
  openSession(sessionId: string) {
    return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_CHANNEL, sessionId);
  },
  openCharacterEditor(characterId?: string | null) {
    return ipcRenderer.invoke(WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL, characterId ?? null);
  },
  openDiffWindow(diffPreview) {
    return ipcRenderer.invoke(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, diffPreview);
  },
  listSessions() {
    return ipcRenderer.invoke(WITHMATE_LIST_SESSIONS_CHANNEL);
  },
  getSession(sessionId: string) {
    return ipcRenderer.invoke(WITHMATE_GET_SESSION_CHANNEL, sessionId);
  },
  getModelCatalog(revision?: number | null) {
    return ipcRenderer.invoke(WITHMATE_GET_MODEL_CATALOG_CHANNEL, revision ?? null);
  },
  importModelCatalog(document) {
    return ipcRenderer.invoke(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, document);
  },
  exportModelCatalog(revision?: number | null) {
    return ipcRenderer.invoke(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, revision ?? null);
  },
  importModelCatalogFile() {
    return ipcRenderer.invoke(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL);
  },
  exportModelCatalogFile(revision?: number | null) {
    return ipcRenderer.invoke(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, revision ?? null);
  },
  getDiffPreview(token: string) {
    return ipcRenderer.invoke(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, token);
  },
  createSession(input) {
    return ipcRenderer.invoke(WITHMATE_CREATE_SESSION_CHANNEL, input);
  },
  updateSession(session) {
    return ipcRenderer.invoke(WITHMATE_UPDATE_SESSION_CHANNEL, session);
  },
  deleteSession(sessionId: string) {
    return ipcRenderer.invoke(WITHMATE_DELETE_SESSION_CHANNEL, sessionId);
  },
  runSessionTurn(sessionId: string, userMessage: string) {
    return ipcRenderer.invoke(WITHMATE_RUN_SESSION_TURN_CHANNEL, sessionId, userMessage);
  },
  listCharacters() {
    return ipcRenderer.invoke(WITHMATE_LIST_CHARACTERS_CHANNEL);
  },
  getCharacter(characterId: string) {
    return ipcRenderer.invoke(WITHMATE_GET_CHARACTER_CHANNEL, characterId);
  },
  createCharacter(input) {
    return ipcRenderer.invoke(WITHMATE_CREATE_CHARACTER_CHANNEL, input);
  },
  updateCharacter(character) {
    return ipcRenderer.invoke(WITHMATE_UPDATE_CHARACTER_CHANNEL, character);
  },
  deleteCharacter(characterId: string) {
    return ipcRenderer.invoke(WITHMATE_DELETE_CHARACTER_CHANNEL, characterId);
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
  subscribeCharacters(listener) {
    const wrapped = (_event: unknown, characters: Awaited<ReturnType<WithMateWindowApi["listCharacters"]>>) => {
      listener(characters);
    };

    ipcRenderer.on(WITHMATE_CHARACTERS_CHANGED_EVENT, wrapped);
    return () => {
      ipcRenderer.removeListener(WITHMATE_CHARACTERS_CHANGED_EVENT, wrapped);
    };
  },
  subscribeModelCatalog(listener) {
    const wrapped = (_event: unknown, catalog: Awaited<ReturnType<WithMateWindowApi["getModelCatalog"]>>) => {
      if (catalog) {
        listener(catalog);
      }
    };

    ipcRenderer.on(WITHMATE_MODEL_CATALOG_CHANGED_EVENT, wrapped);
    return () => {
      ipcRenderer.removeListener(WITHMATE_MODEL_CATALOG_CHANGED_EVENT, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("withmate", withmateApi);
