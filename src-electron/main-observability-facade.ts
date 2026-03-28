import type {
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "../src/app-state.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { ProviderCodingAdapter } from "./provider-runtime.js";
import { fetchProviderQuotaTelemetry } from "./provider-support.js";
import { SessionObservabilityService } from "./session-observability-service.js";

type MainObservabilityFacadeDeps = {
  getSessionObservabilityService(): SessionObservabilityService;
  getAppSettings(): AppSettings;
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
  providerQuotaStaleTtlMs: number;
};

export class MainObservabilityFacade {
  constructor(private readonly deps: MainObservabilityFacadeDeps) {}

  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
    return this.deps.getSessionObservabilityService().getProviderQuotaTelemetry(providerId);
  }

  setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
    this.deps.getSessionObservabilityService().setProviderQuotaTelemetry(providerId, telemetry);
  }

  clearProviderQuotaTelemetry(providerId: string): void {
    this.deps.getSessionObservabilityService().clearProviderQuotaTelemetry(providerId);
  }

  clearAllProviderQuotaTelemetry(): void {
    this.deps.getSessionObservabilityService().clearAllProviderQuotaTelemetry();
  }

  isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean {
    return telemetry
      ? this.deps
          .getSessionObservabilityService()
          .isProviderQuotaTelemetryStale(telemetry.provider, this.deps.providerQuotaStaleTtlMs)
      : true;
  }

  async refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
    return this.deps.getSessionObservabilityService().refreshProviderQuotaTelemetry(providerId, async () =>
        fetchProviderQuotaTelemetry({
        providerId,
        getAppSettings: () => this.deps.getAppSettings(),
        getProviderCodingAdapter: (nextProviderId) => this.deps.getProviderCodingAdapter(nextProviderId),
      }),
    );
  }

  async getOrRefreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
    return this.deps.getSessionObservabilityService().getOrRefreshProviderQuotaTelemetry(
      providerId,
      this.deps.providerQuotaStaleTtlMs,
      async () =>
        fetchProviderQuotaTelemetry({
          providerId,
          getAppSettings: () => this.deps.getAppSettings(),
          getProviderCodingAdapter: (nextProviderId) => this.deps.getProviderCodingAdapter(nextProviderId),
        }),
    );
  }

  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void {
    this.deps.getSessionObservabilityService().scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs, async () =>
      fetchProviderQuotaTelemetry({
        providerId,
        getAppSettings: () => this.deps.getAppSettings(),
        getProviderCodingAdapter: (nextProviderId) => this.deps.getProviderCodingAdapter(nextProviderId),
      }),
    );
  }

  getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null {
    return this.deps.getSessionObservabilityService().getSessionContextTelemetry(sessionId);
  }

  setSessionContextTelemetry(sessionId: string, telemetry: SessionContextTelemetry | null): void {
    this.deps.getSessionObservabilityService().setSessionContextTelemetry(sessionId, telemetry);
  }

  clearSessionContextTelemetry(sessionId: string): void {
    this.deps.getSessionObservabilityService().clearSessionContextTelemetry(sessionId);
  }

  clearAllSessionContextTelemetry(): void {
    this.deps.getSessionObservabilityService().clearAllSessionContextTelemetry();
  }

  getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): SessionBackgroundActivityState | null {
    return this.deps.getSessionObservabilityService().getSessionBackgroundActivity(sessionId, kind);
  }

  setSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
    state: SessionBackgroundActivityState | null,
  ): void {
    this.deps.getSessionObservabilityService().setSessionBackgroundActivity(sessionId, kind, state);
  }

  clearSessionBackgroundActivities(sessionId: string): void {
    this.deps.getSessionObservabilityService().clearSessionBackgroundActivities(sessionId);
  }

  clearAllSessionBackgroundActivities(): void {
    this.deps.getSessionObservabilityService().clearAllSessionBackgroundActivities();
  }

  getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
    return this.deps.getSessionObservabilityService().getLiveSessionRun(sessionId);
  }

  setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void {
    this.deps.getSessionObservabilityService().setLiveSessionRun(sessionId, state);
  }

  updateLiveSessionRun(
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ): LiveSessionRunState | null {
    return this.deps.getSessionObservabilityService().updateLiveSessionRun(sessionId, recipe);
  }
}
