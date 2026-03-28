import {
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionContextTelemetry,
} from "../src/app-state.js";

type SessionObservabilityServiceOptions = {
  onProviderQuotaTelemetryChanged: (providerId: string, telemetry: ProviderQuotaTelemetry | null) => void;
  onSessionContextTelemetryChanged: (sessionId: string, telemetry: SessionContextTelemetry | null) => void;
  onSessionBackgroundActivityChanged: (
    sessionId: string,
    kind: SessionBackgroundActivityKind,
    state: SessionBackgroundActivityState | null,
  ) => void;
  onLiveSessionRunChanged: (sessionId: string, state: LiveSessionRunState | null) => void;
};

export class SessionObservabilityService {
  private readonly liveSessionRuns = new Map<string, LiveSessionRunState>();
  private readonly providerQuotaTelemetryByProvider = new Map<string, ProviderQuotaTelemetry>();
  private readonly sessionContextTelemetryBySessionId = new Map<string, SessionContextTelemetry>();
  private readonly sessionBackgroundActivities = new Map<string, SessionBackgroundActivityState>();
  private readonly providerQuotaRefreshPromises = new Map<string, Promise<ProviderQuotaTelemetry | null>>();
  private readonly providerQuotaRefreshTimers = new Map<string, NodeJS.Timeout[]>();

  public constructor(private readonly options: SessionObservabilityServiceOptions) {}

  public dispose(): void {
    for (const timers of this.providerQuotaRefreshTimers.values()) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    }

    this.providerQuotaRefreshTimers.clear();
    this.providerQuotaRefreshPromises.clear();
    this.providerQuotaTelemetryByProvider.clear();
    this.sessionContextTelemetryBySessionId.clear();
    this.sessionBackgroundActivities.clear();
    this.liveSessionRuns.clear();
  }

  public getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
    return this.providerQuotaTelemetryByProvider.get(providerId) ?? null;
  }

  public setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
    if (telemetry) {
      this.providerQuotaTelemetryByProvider.set(providerId, telemetry);
    } else {
      this.providerQuotaTelemetryByProvider.delete(providerId);
    }

    this.options.onProviderQuotaTelemetryChanged(providerId, telemetry);
  }

  public clearProviderQuotaTelemetry(providerId: string): void {
    this.providerQuotaRefreshPromises.delete(providerId);
    const scheduledTimers = this.providerQuotaRefreshTimers.get(providerId) ?? [];
    for (const timer of scheduledTimers) {
      clearTimeout(timer);
    }
    this.providerQuotaRefreshTimers.delete(providerId);
    this.setProviderQuotaTelemetry(providerId, null);
  }

  public clearAllProviderQuotaTelemetry(): void {
    const providerIds = new Set<string>([
      ...this.providerQuotaTelemetryByProvider.keys(),
      ...this.providerQuotaRefreshPromises.keys(),
    ]);
    this.providerQuotaRefreshPromises.clear();
    this.providerQuotaTelemetryByProvider.clear();
    for (const providerId of providerIds) {
      this.options.onProviderQuotaTelemetryChanged(providerId, null);
    }
  }

  public isProviderQuotaTelemetryStale(providerId: string, staleTtlMs: number): boolean {
    const telemetry = this.getProviderQuotaTelemetry(providerId);
    if (!telemetry) {
      return true;
    }

    const updatedAt = Date.parse(telemetry.updatedAt);
    if (Number.isNaN(updatedAt)) {
      return true;
    }

    return Date.now() - updatedAt >= staleTtlMs;
  }

  public async refreshProviderQuotaTelemetry(
    providerId: string,
    refresh: () => Promise<ProviderQuotaTelemetry | null>,
  ): Promise<ProviderQuotaTelemetry | null> {
    const inFlight = this.providerQuotaRefreshPromises.get(providerId);
    if (inFlight) {
      return inFlight;
    }

    const refreshPromise = (async () => {
      const telemetry = await refresh();
      this.setProviderQuotaTelemetry(providerId, telemetry);
      return telemetry;
    })();

    this.providerQuotaRefreshPromises.set(providerId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.providerQuotaRefreshPromises.delete(providerId);
    }
  }

  public async getOrRefreshProviderQuotaTelemetry(
    providerId: string,
    staleTtlMs: number,
    refresh: () => Promise<ProviderQuotaTelemetry | null>,
  ): Promise<ProviderQuotaTelemetry | null> {
    const current = this.getProviderQuotaTelemetry(providerId);
    if (current && !this.isProviderQuotaTelemetryStale(providerId, staleTtlMs)) {
      return current;
    }

    return this.refreshProviderQuotaTelemetry(providerId, refresh);
  }

  public scheduleProviderQuotaTelemetryRefresh(
    providerId: string,
    delaysMs: number[],
    refresh: () => Promise<ProviderQuotaTelemetry | null>,
  ): void {
    const existingTimers = this.providerQuotaRefreshTimers.get(providerId) ?? [];
    for (const timer of existingTimers) {
      clearTimeout(timer);
    }

    const timers = delaysMs.map((delayMs) =>
      setTimeout(() => {
        void this.refreshProviderQuotaTelemetry(providerId, refresh).catch(() => undefined);
      }, delayMs),
    );
    this.providerQuotaRefreshTimers.set(providerId, timers);
  }

  public getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null {
    return this.sessionContextTelemetryBySessionId.get(sessionId) ?? null;
  }

  public setSessionContextTelemetry(sessionId: string, telemetry: SessionContextTelemetry | null): void {
    if (telemetry) {
      this.sessionContextTelemetryBySessionId.set(sessionId, telemetry);
    } else {
      this.sessionContextTelemetryBySessionId.delete(sessionId);
    }

    this.options.onSessionContextTelemetryChanged(sessionId, telemetry);
  }

  public clearSessionContextTelemetry(sessionId: string): void {
    this.setSessionContextTelemetry(sessionId, null);
  }

  public clearAllSessionContextTelemetry(): void {
    const sessionIds = Array.from(this.sessionContextTelemetryBySessionId.keys());
    this.sessionContextTelemetryBySessionId.clear();
    for (const sessionId of sessionIds) {
      this.options.onSessionContextTelemetryChanged(sessionId, null);
    }
  }

  public getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): SessionBackgroundActivityState | null {
    return this.sessionBackgroundActivities.get(this.buildSessionBackgroundActivityKey(sessionId, kind)) ?? null;
  }

  public setSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
    state: SessionBackgroundActivityState | null,
  ): void {
    const key = this.buildSessionBackgroundActivityKey(sessionId, kind);
    if (state) {
      this.sessionBackgroundActivities.set(key, state);
    } else {
      this.sessionBackgroundActivities.delete(key);
    }

    this.options.onSessionBackgroundActivityChanged(sessionId, kind, state);
  }

  public clearSessionBackgroundActivities(sessionId: string): void {
    this.setSessionBackgroundActivity(sessionId, "memory-generation", null);
    this.setSessionBackgroundActivity(sessionId, "monologue", null);
  }

  public clearAllSessionBackgroundActivities(): void {
    const activityKeys = Array.from(this.sessionBackgroundActivities.keys());
    this.sessionBackgroundActivities.clear();
    for (const key of activityKeys) {
      const [sessionId, kind] = key.split("\u001f") as [string | undefined, SessionBackgroundActivityKind | undefined];
      if (sessionId && kind) {
        this.options.onSessionBackgroundActivityChanged(sessionId, kind, null);
      }
    }
  }

  public getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
    return this.liveSessionRuns.get(sessionId) ?? null;
  }

  public setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void {
    if (state) {
      this.liveSessionRuns.set(sessionId, state);
    } else {
      this.liveSessionRuns.delete(sessionId);
    }

    this.options.onLiveSessionRunChanged(sessionId, state);
  }

  public updateLiveSessionRun(
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ): LiveSessionRunState | null {
    const current = this.getLiveSessionRun(sessionId);
    if (!current) {
      return null;
    }

    const next = recipe(current);
    this.setLiveSessionRun(sessionId, next);
    return next;
  }

  private buildSessionBackgroundActivityKey(sessionId: string, kind: SessionBackgroundActivityKind): string {
    return `${sessionId}\u001f${kind}`;
  }
}
