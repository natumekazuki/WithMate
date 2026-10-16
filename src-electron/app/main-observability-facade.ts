import type { LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityKind, SessionBackgroundActivityState } from "../../src-shared/memory/session-memory-state.js";
import { getProviderAppSettings, type AppSettings, type ProviderAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ProviderCodingAdapter } from "../providers/provider-runtime.js";
import { fetchProviderQuotaTelemetry } from "../providers/provider-support.js";
import { SessionObservabilityService, PROVIDER_QUOTA_REFRESH_INTERVAL_MS } from "../session/session-observability-service.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type MainObservabilityFacadeDeps = {
  getSessionObservabilityService(): SessionObservabilityService;
  getAppSettings(): Awaitable<AppSettings>;
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
  providerQuotaStaleTtlMs: number;
};

export class MainObservabilityFacade {
  private readonly quotaSettings = new Map<string, ProviderAppSettings>();
  constructor(private readonly deps: MainObservabilityFacadeDeps) {}

  configureProviderQuotaPolling(settings: AppSettings): void {
    const service = this.deps.getSessionObservabilityService();
    for (const providerId of ["codex", "claude"]) {
      const next = getProviderAppSettings(settings, providerId);
      const previous = this.quotaSettings.get(providerId);
      if (!previous || previous.enabled !== next.enabled || previous.apiKey !== next.apiKey) {
        service.clearProviderQuotaTelemetry(providerId);
      }
      this.quotaSettings.set(providerId, { ...next });
      if (next.enabled) {
        service.startProviderQuotaPolling(providerId, PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
          (signal) => this.fetchQuota(providerId, signal));
      }
    }
  }

  private fetchQuota(providerId: string, signal: AbortSignal): Promise<ProviderQuotaTelemetry | null> {
    return fetchProviderQuotaTelemetry({
      providerId, signal,
      getAppSettings: () => this.deps.getAppSettings(),
      getProviderCodingAdapter: (nextProviderId) => this.deps.getProviderCodingAdapter(nextProviderId),
    });
  }

  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
    return this.deps.getSessionObservabilityService().getProviderQuotaTelemetry(providerId);
  }

  setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
    if (this.quotaSettings.get(providerId)?.enabled === false) return;
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
    if (this.quotaSettings.get(providerId)?.enabled === false) return null;
    return this.deps.getSessionObservabilityService().refreshProviderQuotaTelemetry(providerId,
      (signal) => this.fetchQuota(providerId, signal));
  }

  async getOrRefreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
    if (providerId === "codex" || providerId === "claude") return this.getProviderQuotaTelemetry(providerId);
    return this.deps.getSessionObservabilityService().getOrRefreshProviderQuotaTelemetry(
      providerId,
      this.deps.providerQuotaStaleTtlMs,
      (signal) => this.fetchQuota(providerId, signal),
    );
  }

  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void {
    if (this.quotaSettings.get(providerId)?.enabled === false) return;
    this.deps.getSessionObservabilityService().scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs,
      (signal) => this.fetchQuota(providerId, signal));
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
