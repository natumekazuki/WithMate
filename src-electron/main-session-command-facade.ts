import type { ProviderQuotaTelemetry, RunSessionTurnRequest } from "../src/runtime-state.js";
import type { CreateSessionInput, Session } from "../src/session-state.js";
import {
  resolveDeleteSessionsLastActiveBeforeCutoff,
  type DeleteSessionsLastActiveBeforeRequest,
  type DeleteSessionsResult,
} from "../src/withmate-window-types.js";
import type { SessionPersistenceService } from "./session-persistence-service.js";
import type { SessionRuntimeService } from "./session-runtime-service.js";

type MainSessionCommandFacadeDeps = {
  getSession(sessionId: string): Session | null;
  getSessionPersistenceService(): SessionPersistenceService;
  getSessionRuntimeService(): SessionRuntimeService;
  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null;
  isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean;
  refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  cleanupSessionFilesDirectory?(sessionId: string): Promise<void>;
};

export class MainSessionCommandFacade {
  constructor(private readonly deps: MainSessionCommandFacadeDeps) {}

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.deps.getSessionPersistenceService().createSession(input);
  }

  async updateSession(session: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().updateSession(session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.cleanupDeletedSessions(
      await this.deps.getSessionPersistenceService().deleteSession(sessionId),
    );
  }

  async deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
  ): Promise<DeleteSessionsResult> {
    const cutoff = resolveDeleteSessionsLastActiveBeforeCutoff(request);
    const result = await this.deps.getSessionPersistenceService().deleteSessionsLastActiveBefore(cutoff);
    await this.cleanupDeletedSessions(result);
    return result;
  }

  cancelSessionRun(sessionId: string): void {
    this.deps.getSessionRuntimeService().cancelRun(sessionId);
  }

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
    const session = this.deps.getSession(sessionId);
    if (
      session?.provider === "copilot" &&
      this.deps.isProviderQuotaTelemetryStale(this.deps.getProviderQuotaTelemetry(session.provider))
    ) {
      void this.deps.refreshProviderQuotaTelemetry(session.provider).catch(() => undefined);
    }

    return this.deps.getSessionRuntimeService().runSessionTurn(sessionId, request);
  }

  private async cleanupDeletedSessions(result: DeleteSessionsResult): Promise<void> {
    for (const sessionId of result.deletedSessionIds) {
      await this.deps.cleanupSessionFilesDirectory?.(sessionId);
    }
  }
}
