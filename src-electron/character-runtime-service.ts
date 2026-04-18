import { cloneCharacterProfiles, type CharacterProfile, type CreateCharacterInput } from "../src/character-state.js";
import type { Session } from "../src/session-state.js";

export type CharacterRuntimeServiceDeps = {
  getCharacters(): CharacterProfile[];
  setCharacters(nextCharacters: CharacterProfile[]): void;
  listStoredCharacters(): Promise<CharacterProfile[]>;
  getStoredCharacter(characterId: string): Promise<CharacterProfile | null>;
  createStoredCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateStoredCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteStoredCharacter(characterId: string): Promise<void>;
  listSessions(): Session[];
  upsertStoredSession(session: Session): Session;
  reloadStoredSessions(): Session[];
  setSessions(nextSessions: Session[]): void;
  closeCharacterEditor(characterId: string): void;
  broadcastCharacters(): void;
  broadcastSessions(sessionIds?: Iterable<string>): void;
};

export class CharacterRuntimeService {
  constructor(private readonly deps: CharacterRuntimeServiceDeps) {}

  listCharacters(): CharacterProfile[] {
    return cloneCharacterProfiles(this.deps.getCharacters());
  }

  async refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
    const nextCharacters = await this.deps.listStoredCharacters();
    this.deps.setCharacters(nextCharacters);
    return this.listCharacters();
  }

  async getCharacter(characterId: string): Promise<CharacterProfile | null> {
    const character = await this.deps.getStoredCharacter(characterId);
    if (!character) {
      return null;
    }

    const nextCharacters = await this.refreshCharactersFromStorage();
    return cloneCharacterProfiles(nextCharacters).find((entry) => entry.id === character.id) ?? character;
  }

  async createCharacter(input: CreateCharacterInput): Promise<CharacterProfile> {
    const created = await this.deps.createStoredCharacter(input);
    await this.refreshCharactersFromStorage();
    this.deps.broadcastCharacters();
    return cloneCharacterProfiles([created])[0];
  }

  async updateCharacter(character: CharacterProfile): Promise<CharacterProfile> {
    const updated = await this.deps.updateStoredCharacter(character);
    await this.refreshCharactersFromStorage();
    this.syncSessionsForCharacter(updated);
    this.deps.broadcastCharacters();
    return cloneCharacterProfiles([updated])[0];
  }

  async deleteCharacter(characterId: string): Promise<void> {
    await this.deps.deleteStoredCharacter(characterId);
    await this.refreshCharactersFromStorage();
    this.deps.broadcastCharacters();
    this.deps.closeCharacterEditor(characterId);
  }

  async resolveSessionCharacter(session: Session): Promise<CharacterProfile | null> {
    if (!session.characterId) {
      return null;
    }

    return this.getCharacter(session.characterId);
  }

  private syncSessionsForCharacter(character: CharacterProfile): void {
    const touched = this.deps.listSessions().filter((session) => session.characterId === character.id);
    if (touched.length === 0) {
      return;
    }

    for (const session of touched) {
      this.deps.upsertStoredSession({
        ...session,
        character: character.name,
        characterIconPath: character.iconPath,
        characterThemeColors: character.themeColors,
      });
    }

    this.deps.setSessions(this.deps.reloadStoredSessions());
    this.deps.broadcastSessions(touched.map((session) => session.id));
  }
}
