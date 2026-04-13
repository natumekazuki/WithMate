import {
  cloneCharacterProfiles,
  type CharacterProfile,
  type ComposerPreview,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type Session,
  cloneSessions,
  type AuditLogEntry,
} from "../src/app-state.js";
import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import { extractTextReferenceCandidates } from "./composer-attachments.js";

type MainQueryServiceDeps = {
  getSessions(): Session[];
  getCharacters(): CharacterProfile[];
  getAuditLogs(sessionId: string): AuditLogEntry[];
  getAppSettings(): AppSettings;
  discoverSessionSkills(workspacePath: string, skillRootPath: string | null): DiscoveredSkill[];
  discoverSessionCustomAgents(workspacePath: string): DiscoveredCustomAgent[];
  getStoredCharacter(characterId: string): Promise<CharacterProfile | null>;
  refreshCharactersFromStorage(): Promise<CharacterProfile[]>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  searchWorkspaceFiles(workspacePath: string, query: string): Promise<string[]>;
  launchTerminalAtPath(workspacePath: string): Promise<void>;
};

export class MainQueryService {
  constructor(private readonly deps: MainQueryServiceDeps) {}

  private cloneSession(session: Session): Session {
    return JSON.parse(JSON.stringify(session)) as Session;
  }

  listSessions(): Session[] {
    return cloneSessions(this.deps.getSessions());
  }

  listCharacters(): CharacterProfile[] {
    return cloneCharacterProfiles(this.deps.getCharacters());
  }

  listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    return this.deps.getAuditLogs(sessionId);
  }

  listSessionSkills(sessionId: string): DiscoveredSkill[] {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    const appSettings = this.deps.getAppSettings();
    const providerSettings = getProviderAppSettings(appSettings, session.provider);
    return this.deps.discoverSessionSkills(session.workspacePath, providerSettings.skillRootPath);
  }

  listSessionCustomAgents(sessionId: string): DiscoveredCustomAgent[] {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    if (session.provider !== "copilot") {
      return [];
    }

    return this.deps.discoverSessionCustomAgents(session.workspacePath);
  }

  getSession(sessionId: string): Session | null {
    const session = this.deps.getSessions().find((entry) => entry.id === sessionId);
    return session ? this.cloneSession(session) : null;
  }

  async getCharacter(characterId: string): Promise<CharacterProfile | null> {
    return this.deps.getStoredCharacter(characterId);
  }

  async refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
    return this.deps.refreshCharactersFromStorage();
  }

  async previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview> {
    if (extractTextReferenceCandidates(userMessage).length === 0) {
      return { attachments: [], errors: [] };
    }

    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.deps.resolveComposerPreview(session, userMessage);
  }

  async searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.deps.searchWorkspaceFiles(session.workspacePath, query);
  }

  async openSessionTerminal(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    await this.deps.launchTerminalAtPath(session.workspacePath);
  }
}
