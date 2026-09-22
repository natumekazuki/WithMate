import type {
  WithMateWindowCharacterApi,
  WithMateWindowMateApi,
  WithMateWindowSettingsApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

export function createMateApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowMateApi {
  return {
    getMateState() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_MATE_STATE_CHANNEL);
    },
    getMateProfile() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_MATE_PROFILE_CHANNEL);
    },
    createMate(input) {
      return ipcRenderer.invoke(channels.WITHMATE_CREATE_MATE_CHANNEL, input);
    },
    updateMate(input) {
      return ipcRenderer.invoke(channels.WITHMATE_UPDATE_MATE_CHANNEL, input);
    },
    setMateAvatar(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_MATE_AVATAR_CHANNEL,
        input,
      );
    },
    resetMate() {
      return ipcRenderer.invoke(channels.WITHMATE_RESET_MATE_CHANNEL);
    },
  };
}

export function createCharacterApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowCharacterApi {
  return {
    listCharacters(options) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_CHARACTERS_CHANNEL,
        options ?? null,
      );
    },
    getCharacter(characterId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_CHARACTER_CHANNEL,
        characterId,
      );
    },
    createCharacter(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_CHARACTER_CHANNEL,
        input,
      );
    },
    updateCharacterMetadata(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL,
        input,
      );
    },
    updateCharacterDefinition(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL,
        input,
      );
    },
    archiveCharacter(characterId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_ARCHIVE_CHARACTER_CHANNEL,
        characterId,
      );
    },
    resolveLaunchCharacter(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
        input ?? null,
      );
    },
    startCharacterAuthoringSession(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL,
        input,
      );
    },
  };
}

export function createSettingsApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowSettingsApi {
  return {
    getAppSettings() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_APP_SETTINGS_CHANNEL);
    },
    updateAppSettings(settings) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
        settings,
      );
    },
    updateChatLayoutPreference(update) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
        update,
      );
    },
    getAppDatabaseDiagnostics() {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
      );
    },
    getMemoryV6Diagnostics() {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
      );
    },
    installMemoryV6CliShim() {
      return ipcRenderer.invoke(
        channels.WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
      );
    },
    uninstallMemoryV6CliShim() {
      return ipcRenderer.invoke(
        channels.WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
      );
    },
    resetAppDatabase(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESET_APP_DATABASE_CHANNEL,
        request,
      );
    },
    deleteSessionsLastActiveBefore(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
        request,
      );
    },
  };
}
