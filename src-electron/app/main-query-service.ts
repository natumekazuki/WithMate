import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { ComposerPreview, DiscoveredCustomAgent, DiscoveredSkill } from "../../src-shared/session/runtime-state.js";
import type { MessageArtifact, Session, SessionCharacterUsage, SessionSummaryPageRequest, HomeSessionSummaryPageResult, SessionSummary } from "../../src-shared/session/session-state.js";
import { cloneHomeSessionSummaries, cloneSessionSummaries, cloneSessions } from "../../src-shared/session/session-state.js";
import { getProviderAppSettings, resolveProviderSkillRootPath, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { extractComposerAttachmentReferenceCandidates } from "../../src-shared/files/path-reference.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type MainQueryServiceDeps = {
  getSessionSummaries(): Awaitable<SessionSummary[]>;
  getSessionSummaryPage(request?: SessionSummaryPageRequest | null): Awaitable<HomeSessionSummaryPageResult>;
  getSessionCharacterUsage(): Awaitable<SessionCharacterUsage[]>;
  getSession(sessionId: string): Awaitable<Session | null>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Awaitable<MessageArtifact | null>;
  getLatestSessionTurn(sessionId: string): Awaitable<SessionTurnRecord | null>;
  getAppSettings(): Awaitable<AppSettings>;
  discoverSessionSkills(workspacePath: string, skillRootPath: string | null): Promise<DiscoveredSkill[]>;
  discoverSessionCustomAgents(workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  resolveComposerPreview(session: SessionSummary, userMessage: string): Promise<ComposerPreview>;
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

  async listSessionSummaryPage(request?: SessionSummaryPageRequest | null): Promise<HomeSessionSummaryPageResult> {
    const page = await this.deps.getSessionSummaryPage(request);
    return {
      entries: cloneHomeSessionSummaries(page.entries),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  async listSessionCharacterUsage(): Promise<SessionCharacterUsage[]> {
    return (await this.deps.getSessionCharacterUsage()).map((usage) => ({ ...usage }));
  }

  async getLatestSessionTurn(sessionId: string): Promise<SessionTurnRecord | null> {
    return this.deps.getLatestSessionTurn(sessionId);
  }

  async listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    return this.listWorkspaceSkills(session.provider, session.workspacePath);
  }

  async listWorkspaceSkills(providerId: string, workspacePath: string): Promise<DiscoveredSkill[]> {
    const appSettings = await this.deps.getAppSettings();
    const providerSettings = getProviderAppSettings(appSettings, providerId);
    return this.deps.discoverSessionSkills(workspacePath, resolveProviderSkillRootPath(providerSettings));
  }

  async listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
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

  async previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview> {
    if (extractComposerAttachmentReferenceCandidates(userMessage).length === 0) {
      return { attachments: [], errors: [] };
    }

    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    return this.deps.resolveComposerPreview(session, userMessage);
  }

  async openSessionTerminal(sessionId: string): Promise<void> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    await this.openTerminalAtPath(session.workspacePath);
  }

  async openTerminalAtPath(workspacePath: string): Promise<void> {
    await this.deps.launchTerminalAtPath(workspacePath);
  }
}
