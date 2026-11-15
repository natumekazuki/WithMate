import type {
  WithMateWindowPromptTemplateApi,
  WithMateWindowPickerApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

export function createPromptTemplateApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowPromptTemplateApi {
  return {
    listPromptTemplates() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL,
      );
    },
    createPromptTemplate(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL,
        input,
      );
    },
    updatePromptTemplate(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL,
        input,
      );
    },
    deletePromptTemplate(id) {
      return ipcRenderer.invoke(
        channels.WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL,
        id,
      );
    },
    subscribePromptTemplates(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_PROMPT_TEMPLATES_CHANGED_EVENT,
        listener,
      );
    },
  };
}

export function createPickerApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowPickerApi {
  return {
    validateWorkspaceDirectory(targetPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL,
        targetPath,
      );
    },
    pickDirectory(initialPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_DIRECTORY_CHANNEL,
        initialPath ?? null,
      );
    },
    pickFile(initialPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_FILE_CHANNEL,
        initialPath ?? null,
      );
    },
    pickFiles(initialPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_FILES_CHANNEL,
        initialPath ?? null,
      );
    },
    pickSessionFiles(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_SESSION_FILES_CHANNEL,
        sessionId,
      );
    },
    pickSessionFolder(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_SESSION_FOLDER_CHANNEL,
        sessionId,
      );
    },
    pickSessionImageFile(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL,
        sessionId,
      );
    },
    pickImageFile(initialPath, purpose) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_IMAGE_FILE_CHANNEL,
        initialPath ?? null,
        purpose ?? "general",
      );
    },
    copyFilesToSessionFiles(sessionId, sourcePaths) {
      return ipcRenderer.invoke(
        channels.WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
        sessionId,
        sourcePaths,
      );
    },
    savePastedSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
        request,
      );
    },
    openSessionFilesDirectory(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
        sessionId,
      );
    },
    openSessionFilesTerminal(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
        sessionId,
      );
    },
  };
}
