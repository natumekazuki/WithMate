import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CharacterRuntimeSnapshot,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import {
  CharacterWorkspaceOperationCoordinator,
  type RunCharacterWorkspaceOperationExclusive,
} from "./character-workspace-operation-coordinator.js";

type Awaitable<T> = T | Promise<T>;
export const CHARACTER_CATALOG_OPERATION_KEY = "__character-catalog__";

export type CharacterCatalogServiceStorage = {
  listCharacters(options?: { includeArchived?: boolean }): Awaitable<CharacterCatalogEntry[]>;
  getCharacterCatalogEntry(characterId: string): Awaitable<CharacterCatalogEntry | null>;
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  updateCharacterMetadata(input: UpdateCharacterMetadataInput): Awaitable<CharacterDetail>;
  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): Awaitable<CharacterDetail>;
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  resolveLaunchCharacter(input: ResolveLaunchCharacterInput): Awaitable<CharacterDetail | null>;
  createRuntimeSnapshot(characterId: string): Awaitable<CharacterRuntimeSnapshot | null>;
  getCharacterDirectory(characterId: string): Awaitable<string | null>;
};

export class CharacterService {
  constructor(
    private readonly storage: CharacterCatalogServiceStorage,
    workspaceCoordinator: CharacterWorkspaceOperationCoordinator = new CharacterWorkspaceOperationCoordinator(),
  ) {
    this.workspaceOperations = workspaceCoordinator.runExclusive.bind(workspaceCoordinator);
  }

  private readonly workspaceOperations: RunCharacterWorkspaceOperationExclusive;

  async listCharacters(options?: { includeArchived?: boolean }): Promise<CharacterCatalogEntry[]> {
    return await this.storage.listCharacters(options);
  }

  async getCharacterCatalogEntry(characterId: string): Promise<CharacterCatalogEntry | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.getCharacterCatalogEntry(characterId);
  }

  async getCharacter(characterId: string): Promise<CharacterDetail | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.getCharacter(characterId);
  }

  async createCharacter(input: CreateCharacterInput): Promise<CharacterDetail> {
    return this.workspaceOperations(
      CHARACTER_CATALOG_OPERATION_KEY,
      async () => await this.storage.createCharacter(input),
    );
  }

  async updateCharacterMetadata(input: UpdateCharacterMetadataInput): Promise<CharacterDetail> {
    return this.workspaceOperations(input.characterId, async () => await this.storage.updateCharacterMetadata(input));
  }

  async updateCharacterDefinition(input: UpdateCharacterDefinitionInput): Promise<CharacterDetail> {
    return this.workspaceOperations(input.characterId, async () => await this.storage.updateCharacterDefinition(input));
  }

  async archiveCharacter(characterId: string): Promise<CharacterCatalogEntry> {
    return this.workspaceOperations(characterId, async () => await this.storage.archiveCharacter(characterId));
  }

  async resolveLaunchCharacter(input?: ResolveLaunchCharacterInput | null): Promise<CharacterDetail | null> {
    return await this.storage.resolveLaunchCharacter(input ?? {});
  }

  async createRuntimeSnapshot(characterId: string): Promise<CharacterRuntimeSnapshot | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.createRuntimeSnapshot(characterId);
  }

  async getCharacterDirectory(characterId: string): Promise<string | null> {
    if (!characterId) {
      return null;
    }
    return await this.storage.getCharacterDirectory(characterId);
  }
}
