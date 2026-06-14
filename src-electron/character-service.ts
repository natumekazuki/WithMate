import type {
  CharacterCatalogEntry,
  CharacterDetail,
  ImportCharacterPackFileResult,
  CharacterRuntimeSnapshot,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import type { CharacterStorage } from "./character-storage.js";

export type CharacterCatalogServiceStorage = Pick<
  CharacterStorage,
  | "listCharacters"
  | "getCharacter"
  | "createCharacter"
  | "importCharacterPackFile"
  | "updateCharacterMetadata"
  | "updateCharacterDefinition"
  | "archiveCharacter"
  | "setDefaultCharacter"
  | "resolveLaunchCharacter"
  | "createRuntimeSnapshot"
>;

export class CharacterService {
  constructor(private readonly storage: CharacterCatalogServiceStorage) {}

  listCharacters(options?: { includeArchived?: boolean }): CharacterCatalogEntry[] {
    return this.storage.listCharacters(options);
  }

  getCharacter(characterId: string): CharacterDetail | null {
    if (!characterId) {
      return null;
    }
    return this.storage.getCharacter(characterId);
  }

  createCharacter(input: CreateCharacterInput): CharacterDetail {
    return this.storage.createCharacter(input);
  }

  importCharacterPackFile(filePath: string): ImportCharacterPackFileResult {
    return this.storage.importCharacterPackFile(filePath);
  }

  updateCharacterMetadata(input: UpdateCharacterMetadataInput): CharacterDetail {
    return this.storage.updateCharacterMetadata(input);
  }

  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): CharacterDetail {
    return this.storage.updateCharacterDefinition(input);
  }

  archiveCharacter(characterId: string): CharacterCatalogEntry {
    return this.storage.archiveCharacter(characterId);
  }

  setDefaultCharacter(characterId: string): CharacterCatalogEntry {
    return this.storage.setDefaultCharacter(characterId);
  }

  resolveLaunchCharacter(input?: ResolveLaunchCharacterInput | null): CharacterDetail | null {
    return this.storage.resolveLaunchCharacter(input ?? {});
  }

  createRuntimeSnapshot(characterId: string): CharacterRuntimeSnapshot | null {
    if (!characterId) {
      return null;
    }
    return this.storage.createRuntimeSnapshot(characterId);
  }
}
