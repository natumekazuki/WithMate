import type { LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityKind, SessionBackgroundActivityState } from "../../src-shared/memory/session-memory-state.js";

export const PROVIDER_QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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
  private readonly providerQuotaRefreshPromises = new Map<string, { promise: Promise<ProviderQuotaTelemetry | null>; controller: AbortController }>();
  private readonly providerQuotaRefreshTimers = new Map<string, NodeJS.Timeout[]>();
  private readonly providerQuotaPollingTimers = new Map<string, NodeJS.Timeout>();
  private readonly providerQuotaRetryNotBefore = new Map<string, number>();
  private readonly providerQuotaOperations = new Set<Promise<ProviderQuotaTelemetry | null>>();
  private disposed = false;

  public constructor(private readonly options: SessionObservabilityServiceOptions) {}

  public dispose(): void {
    this.disposed = true;
    this.clearAllProviderQuotaTelemetry();
    this.providerQuotaTelemetryByProvider.clear();
    this.sessionContextTelemetryBySessionId.clear();
    this.sessionBackgroundActivities.clear();
    this.liveSessionRuns.clear();
  }

  public getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
    return this.providerQuotaTelemetryByProvider.get(providerId) ?? null;
  }

  public async waitForProviderQuotaRefreshes(): Promise<void> {
    await Promise.allSettled([...this.providerQuotaOperations]);
  }

  public setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
    if (this.disposed) return;
    if (telemetry) {
      this.providerQuotaTelemetryByProvider.set(providerId, telemetry);
    } else {
      this.providerQuotaTelemetryByProvider.delete(providerId);
    }

    this.options.onProviderQuotaTelemetryChanged(providerId, telemetry);
  }

  public clearProviderQuotaTelemetry(providerId: string): void {
    this.providerQuotaRefreshPromises.get(providerId)?.controller.abort();
    this.providerQuotaRefreshPromises.delete(providerId);
    this.providerQuotaRetryNotBefore.delete(providerId);
    clearInterval(this.providerQuotaPollingTimers.get(providerId));
    this.providerQuotaPollingTimers.delete(providerId);
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
      ...this.providerQuotaRefreshTimers.keys(),
      ...this.providerQuotaPollingTimers.keys(),
      ...this.providerQuotaRetryNotBefore.keys(),
    ]);
    for (const providerId of providerIds) {
      this.clearProviderQuotaTelemetry(providerId);
    }
  }

  public isProviderQuotaTelemetryStale(providerId: string, staleTtlMs: number): boolean {
    const telemetry = this.getProviderQuotaTelemetry(providerId);
    if (!telemetry?.updatedAt) {
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
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): Promise<ProviderQuotaTelemetry | null> {
    if (this.disposed) return null;
    if (Date.now() < (this.providerQuotaRetryNotBefore.get(providerId) ?? 0)) {
      return this.getProviderQuotaTelemetry(providerId);
    }
    const inFlight = this.providerQuotaRefreshPromises.get(providerId);
    if (inFlight) {
      return inFlight.promise;
    }
    const controller = new AbortController();
    const attemptStartedAt = Date.now();
    const tracksStatus = providerId === "codex" || providerId === "claude";
    const current = this.getProviderQuotaTelemetry(providerId);
    const operation = { controller, promise: Promise.resolve<ProviderQuotaTelemetry | null>(null) };
    operation.promise = Promise.resolve().then(() => controller.signal.aborted ? null : refresh(controller.signal)).then((telemetry) => {
      if (this.providerQuotaRefreshPromises.get(providerId) !== operation) return null;
      const next = telemetry ?? (tracksStatus
        ? { provider: providerId, updatedAt: null, snapshots: [], status: "unsupported" as const }
        : null);
      this.setProviderQuotaTelemetry(providerId, next);
      this.providerQuotaRetryNotBefore.delete(providerId);
      return next;
    }, (error: unknown) => {
      if (this.providerQuotaRefreshPromises.get(providerId) !== operation) return null;
      if (tracksStatus) {
        this.providerQuotaRetryNotBefore.set(providerId, attemptStartedAt + PROVIDER_QUOTA_REFRESH_INTERVAL_MS);
        const latest = this.getProviderQuotaTelemetry(providerId);
        this.setProviderQuotaTelemetry(providerId, {
          ...latest, provider: providerId, updatedAt: latest?.updatedAt ?? null,
          snapshots: latest?.snapshots ?? [], status: "error",
        });
      }
      throw error;
    });
    this.providerQuotaRefreshPromises.set(providerId, operation);
    this.providerQuotaOperations.add(operation.promise);
    if (tracksStatus) this.setProviderQuotaTelemetry(providerId, {
      ...current, provider: providerId, updatedAt: current?.updatedAt ?? null,
      snapshots: current?.snapshots ?? [], status: "loading",
    });
    try {
      return await operation.promise;
    } finally {
      this.providerQuotaOperations.delete(operation.promise);
      if (this.providerQuotaRefreshPromises.get(providerId) === operation) this.providerQuotaRefreshPromises.delete(providerId);
    }
  }

  public async getOrRefreshProviderQuotaTelemetry(
    providerId: string,
    staleTtlMs: number,
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
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
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): void {
    if (this.disposed) return;
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

  public hasProviderQuotaPolling(providerId: string): boolean {
    return this.providerQuotaPollingTimers.has(providerId);
  }

  public startProviderQuotaPolling(
    providerId: string,
    intervalMs: number,
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): void {
    if (this.disposed || this.hasProviderQuotaPolling(providerId)) return;
    this.scheduleProviderQuotaTelemetryRefresh(providerId, [0], refresh);
    const timer = setInterval(() => {
      void this.refreshProviderQuotaTelemetry(providerId, refresh).catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    this.providerQuotaPollingTimers.set(providerId, timer);
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
