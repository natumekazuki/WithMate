import type { ProviderQuotaTelemetry, RunSessionTurnRequest } from "../src/runtime-state.js";
import type { CreateSessionInput, Session } from "../src/session-state.js";
import type { MemoryOrchestrationService } from "./memory-orchestration-service.js";
import type { SessionPersistenceService } from "./session-persistence-service.js";
import type { SessionRuntimeService } from "./session-runtime-service.js";

type MainSessionCommandFacadeDeps = {
  getSession(sessionId: string): Session | null;
  getSessionPersistenceService(): SessionPersistenceService;
  getSessionRuntimeService(): SessionRuntimeService;
  getMemoryOrchestrationService(): MemoryOrchestrationService;
  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null;
  isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean;
  refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
};

export class MainSessionCommandFacade {
  constructor(private readonly deps: MainSessionCommandFacadeDeps) {}

  createSession(input: CreateSessionInput): Session {
    return this.deps.getSessionPersistenceService().createSession(input);
  }

  updateSession(session: Session): Session {
    return this.deps.getSessionPersistenceService().updateSession(session);
  }

  deleteSession(sessionId: string): void {
    this.deps.getSessionPersistenceService().deleteSession(sessionId);
  }

  cancelSessionRun(sessionId: string): void {
    this.deps.getSessionRuntimeService().cancelRun(sessionId);
  }

  runSessionMemoryExtraction(sessionId: string): void {
    const session = this.deps.getSession(sessionId);
    if (!session || this.deps.getSessionRuntimeService().isRunInFlight(sessionId)) {
      return;
    }
    if (session.status === "running" || session.runState === "running") {
      return;
    }

    void this.deps.getMemoryOrchestrationService().runSessionMemoryExtraction(session, null, {
      force: true,
      triggerReason: "manual",
    });
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
}
