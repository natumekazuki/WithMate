import {
  cloneCharacterProfiles,
  type CharacterProfile,
  type ComposerPreview,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type Session,
  type AuditLogDetail,
  type AuditLogEntry,
  type AuditLogSummary,
  type AuditLogSummaryPageRequest,
  type AuditLogSummaryPageResult,
  type SessionSummary,
  cloneSessionSummaries,
  cloneSessions,
} from "../src/app-state.js";
import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import { extractTextReferenceCandidates } from "../src/path-reference.js";
import type { WorkspacePathCandidate } from "../src/workspace-path-candidate.js";

type MainQueryServiceDeps = {
  getSessionSummaries(): SessionSummary[];
  getSession(sessionId: string): Session | null;
  getCharacters(): CharacterProfile[];
  getAuditLogs(sessionId: string): AuditLogEntry[];
  getAuditLogSummaries(sessionId: string): AuditLogSummary[];
  getAuditLogSummaryPage(sessionId: string, request?: AuditLogSummaryPageRequest | null): AuditLogSummaryPageResult;
  getAuditLogDetail(sessionId: string, auditLogId: number): AuditLogDetail | null;
  getAppSettings(): AppSettings;
  discoverSessionSkills(workspacePath: string, skillRootPath: string | null): Promise<DiscoveredSkill[]>;
  discoverSessionCustomAgents(workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  getStoredCharacter(characterId: string): Promise<CharacterProfile | null>;
  refreshCharactersFromStorage(): Promise<CharacterProfile[]>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  searchWorkspaceFiles(workspacePath: string, query: string): Promise<WorkspacePathCandidate[]>;
  launchTerminalAtPath(workspacePath: string): Promise<void>;
};

export class MainQueryService {
  constructor(private readonly deps: MainQueryServiceDeps) {}

  private cloneSession(session: Session): Session {
    return cloneSessions([session])[0] as Session;
  }

  private cloneSessionSummary(session: SessionSummary): SessionSummary {
    return cloneSessionSummaries([session])[0] as SessionSummary;
  }

  private getSessionSummary(sessionId: string): SessionSummary | null {
    const session = this.deps.getSessionSummaries().find((entry) => entry.id === sessionId);
    return session ? this.cloneSessionSummary(session) : null;
  }

  listSessionSummaries(): SessionSummary[] {
    return cloneSessionSummaries(this.deps.getSessionSummaries());
  }

  listCharacters(): CharacterProfile[] {
    return cloneCharacterProfiles(this.deps.getCharacters());
  }

  listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    return this.deps.getAuditLogs(sessionId);
  }

  listSessionAuditLogSummaries(sessionId: string): AuditLogSummary[] {
    return this.deps.getAuditLogSummaries(sessionId);
  }

  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): AuditLogSummaryPageResult {
    return this.deps.getAuditLogSummaryPage(sessionId, request);
  }

  getSessionAuditLogDetail(sessionId: string, auditLogId: number): AuditLogDetail | null {
    return this.deps.getAuditLogDetail(sessionId, auditLogId);
  }

  async listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.listWorkspaceSkills(session.provider, session.workspacePath);
  }

  async listWorkspaceSkills(providerId: string, workspacePath: string): Promise<DiscoveredSkill[]> {
    const appSettings = this.deps.getAppSettings();
    const providerSettings = getProviderAppSettings(appSettings, providerId);
    return this.deps.discoverSessionSkills(workspacePath, providerSettings.skillRootPath);
  }

  async listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.listWorkspaceCustomAgents(session.provider, session.workspacePath);
  }

  async listWorkspaceCustomAgents(providerId: string, workspacePath: string): Promise<DiscoveredCustomAgent[]> {
    if (providerId !== "copilot") {
      return [];
    }

    return this.deps.discoverSessionCustomAgents(workspacePath);
  }

  getSession(sessionId: string): Session | null {
    const session = this.deps.getSession(sessionId);
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

  async searchWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]> {
    const session = this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.deps.searchWorkspaceFiles(session.workspacePath, query);
  }

  async openSessionTerminal(sessionId: string): Promise<void> {
    const session = this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    await this.openTerminalAtPath(session.workspacePath);
  }

  async openTerminalAtPath(workspacePath: string): Promise<void> {
    await this.deps.launchTerminalAtPath(workspacePath);
  }
}
