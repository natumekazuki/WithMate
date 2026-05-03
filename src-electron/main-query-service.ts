import {
  cloneCharacterProfiles,
  type CharacterProfile,
  type ComposerPreview,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type MessageArtifact,
  type Session,
  type AuditLogDetail,
  type AuditLogDetailFragment,
  type AuditLogDetailSection,
  type AuditLogEntry,
  type AuditLogOperationDetailFragment,
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
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

type MainQueryServiceDeps = {
  getSessionSummaries(): Awaitable<SessionSummary[]>;
  getSession(sessionId: string): Awaitable<Session | null>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Awaitable<MessageArtifact | null>;
  getCharacters(): CharacterProfile[];
  getAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]>;
  getAuditLogSummaries(sessionId: string): Awaitable<AuditLogSummary[]>;
  getAuditLogSummaryPage(sessionId: string, request?: AuditLogSummaryPageRequest | null): Awaitable<AuditLogSummaryPageResult>;
  getAuditLogDetail(sessionId: string, auditLogId: number): Awaitable<AuditLogDetail | null>;
  getAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Awaitable<AuditLogDetailFragment | null>;
  getAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Awaitable<AuditLogOperationDetailFragment | null>;
  getAppSettings(): AppSettings;
  discoverSessionSkills(workspacePath: string, skillRootPath: string | null): Promise<DiscoveredSkill[]>;
  discoverSessionCustomAgents(workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  getStoredCharacter(characterId: string): Promise<CharacterProfile | null>;
  refreshCharactersFromStorage(): Promise<CharacterProfile[]>;
  resolveComposerPreview(session: SessionSummary, userMessage: string): Promise<ComposerPreview>;
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

  private async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const session = (await this.deps.getSessionSummaries()).find((entry) => entry.id === sessionId);
    return session ? this.cloneSessionSummary(session) : null;
  }

  async listSessionSummaries(): Promise<SessionSummary[]> {
    return cloneSessionSummaries(await this.deps.getSessionSummaries());
  }

  listCharacters(): CharacterProfile[] {
    return cloneCharacterProfiles(this.deps.getCharacters());
  }

  async listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]> {
    return this.deps.getAuditLogs(sessionId);
  }

  async listSessionAuditLogSummaries(sessionId: string): Promise<AuditLogSummary[]> {
    return this.deps.getAuditLogSummaries(sessionId);
  }

  async listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): Promise<AuditLogSummaryPageResult> {
    return this.deps.getAuditLogSummaryPage(sessionId, request);
  }

  async getSessionAuditLogDetail(sessionId: string, auditLogId: number): Promise<AuditLogDetail | null> {
    return this.deps.getAuditLogDetail(sessionId, auditLogId);
  }

  async getSessionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Promise<AuditLogDetailFragment | null> {
    return this.deps.getAuditLogDetailSection(sessionId, auditLogId, section);
  }

  async getSessionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Promise<AuditLogOperationDetailFragment | null> {
    return this.deps.getAuditLogOperationDetail(sessionId, auditLogId, operationIndex);
  }

  async listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
    const session = await this.getSessionSummary(sessionId);
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
    const session = await this.getSessionSummary(sessionId);
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

  async getSession(sessionId: string): Promise<Session | null> {
    const session = await this.deps.getSession(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  async getSessionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null> {
    if (!Number.isInteger(messageIndex) || messageIndex < 0) {
      return null;
    }

    const artifact = await this.deps.getSessionMessageArtifact(sessionId, messageIndex);
    return artifact ? JSON.parse(JSON.stringify(artifact)) as MessageArtifact : null;
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

    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.deps.resolveComposerPreview(session, userMessage);
  }

  async searchWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    return this.deps.searchWorkspaceFiles(session.workspacePath, query);
  }

  async openSessionTerminal(sessionId: string): Promise<void> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    await this.openTerminalAtPath(session.workspacePath);
  }

  async openTerminalAtPath(workspacePath: string): Promise<void> {
    await this.deps.launchTerminalAtPath(workspacePath);
  }
}
