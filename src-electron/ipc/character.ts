import type { StartCharacterAuthoringSessionInput } from "../../src-shared/character/character-authoring.js";
import type {
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";

import {
  WITHMATE_ARCHIVE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

import type { IpcHandleRegistrar, MainIpcCharacterDeps } from "./contracts.js";

export function registerCharacterHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcCharacterDeps,
): void {
  ipcMain.handle(
    WITHMATE_LIST_CHARACTERS_CHANNEL,
    (_event, options: { includeArchived?: boolean } | null) =>
      deps.listCharacters(options ?? undefined),
  );
  ipcMain.handle(
    WITHMATE_GET_CHARACTER_CHANNEL,
    (_event, characterId: string) => {
      if (!characterId) {
        return null;
      }
      return deps.getCharacter(characterId);
    },
  );
  ipcMain.handle(
    WITHMATE_CREATE_CHARACTER_CHANNEL,
    (_event, input: CreateCharacterInput) => deps.createCharacter(input),
  );
  ipcMain.handle(
    WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL,
    (_event, input: UpdateCharacterMetadataInput) =>
      deps.updateCharacterMetadata(input),
  );
  ipcMain.handle(
    WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL,
    (_event, input: UpdateCharacterDefinitionInput) =>
      deps.updateCharacterDefinition(input),
  );
  ipcMain.handle(
    WITHMATE_ARCHIVE_CHARACTER_CHANNEL,
    (_event, characterId: string) => deps.archiveCharacter(characterId),
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
    (_event, input: ResolveLaunchCharacterInput | null) =>
      deps.resolveLaunchCharacter(input),
  );
  ipcMain.handle(
    WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL,
    (_event, input: StartCharacterAuthoringSessionInput) =>
      deps.startCharacterAuthoringSession(input),
  );
}
