import type { CharacterProfile, CreateCharacterInput } from "../src/character-state.js";
import type { Session } from "../src/session-state.js";
import type { CharacterRuntimeService } from "./character-runtime-service.js";
import type { CharacterUpdateWorkspaceService } from "./character-update-workspace-service.js";
import type { MainQueryService } from "./main-query-service.js";

type MainCharacterFacadeDeps = {
  getMainQueryService(): MainQueryService;
  getCharacterRuntimeService(): CharacterRuntimeService;
  getCharacterUpdateWorkspaceService(): CharacterUpdateWorkspaceService;
};

export class MainCharacterFacade {
  constructor(private readonly deps: MainCharacterFacadeDeps) {}

  listCharacters(): CharacterProfile[] {
    return this.deps.getMainQueryService().listCharacters();
  }

  async refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
    return this.deps.getMainQueryService().refreshCharactersFromStorage();
  }

  async getCharacter(characterId: string): Promise<CharacterProfile | null> {
    return this.deps.getMainQueryService().getCharacter(characterId);
  }

  async createCharacter(input: CreateCharacterInput): Promise<CharacterProfile> {
    return this.deps.getCharacterRuntimeService().createCharacter(input);
  }

  async updateCharacter(character: CharacterProfile): Promise<CharacterProfile> {
    return this.deps.getCharacterRuntimeService().updateCharacter(character);
  }

  async deleteCharacter(characterId: string): Promise<void> {
    await this.deps.getCharacterRuntimeService().deleteCharacter(characterId);
  }

  async resolveSessionCharacter(session: Session): Promise<CharacterProfile | null> {
    return this.deps.getCharacterRuntimeService().resolveSessionCharacter(session);
  }

  async getCharacterUpdateWorkspace(characterId: string) {
    return this.deps.getCharacterUpdateWorkspaceService().getWorkspace(characterId);
  }

  async extractCharacterUpdateMemory(characterId: string) {
    return this.deps.getCharacterUpdateWorkspaceService().buildMemoryExtract(characterId);
  }

  async createCharacterUpdateSession(characterId: string, providerId: string): Promise<Session> {
    return this.deps.getCharacterUpdateWorkspaceService().createUpdateSession(characterId, providerId);
  }
}
