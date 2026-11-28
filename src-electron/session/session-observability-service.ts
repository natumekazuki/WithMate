import type {
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";

/** 利用枠の定期取得と、失敗後の再取得を抑える基準間隔（ミリ秒）。 */
export const PROVIDER_QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PROVIDER_QUOTA_MIN_REFRESH_INTERVAL_MS = 60 * 1000;

/** 利用枠、コンテキスト使用量、ライブ実行の変化をそれぞれ配信するための通知先。 */
type SessionObservabilityServiceOptions = {
  onProviderQuotaTelemetryChanged: (
    providerId: string,
    telemetry: ProviderQuotaTelemetry | null,
  ) => void;
  onSessionContextTelemetryChanged: (
    sessionId: string,
    telemetry: SessionContextTelemetry | null,
  ) => void;
  onLiveSessionRunChanged: (
    sessionId: string,
    state: LiveSessionRunState | null,
  ) => void;
};

/** プロバイダー別の利用枠と Session 別の実行表示をメモリで管理し、利用枠の取得を調整する。 */
export class SessionObservabilityService {
  private readonly liveSessionRuns = new Map<string, LiveSessionRunState>();
  private readonly providerQuotaTelemetryByProvider = new Map<
    string,
    ProviderQuotaTelemetry
  >();
  private readonly sessionContextTelemetryBySessionId = new Map<
    string,
    SessionContextTelemetry
  >();
  private readonly providerQuotaRefreshPromises = new Map<
    string,
    {
      promise: Promise<ProviderQuotaTelemetry | null>;
      controller: AbortController;
    }
  >();
  private readonly providerQuotaRefreshTimers = new Map<
    string,
    NodeJS.Timeout[]
  >();
  private readonly providerQuotaPollingTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly providerQuotaRetryNotBefore = new Map<string, number>();
  private readonly providerQuotaSuccessNotBefore = new Map<string, number>();
  private readonly providerQuotaTrailingTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly providerQuotaOperations = new Set<
    Promise<ProviderQuotaTelemetry | null>
  >();
  private disposed = false;

  /** 取得した状態を表示側へ伝える各通知先を設定する。 */
  public constructor(
    private readonly options: SessionObservabilityServiceOptions,
  ) {}

  /** 利用枠の取得と予約を中断し、キャッシュと実行表示を破棄する。破棄後の利用枠更新は公開しない。 */
  public dispose(): void {
    this.disposed = true;
    this.clearAllProviderQuotaTelemetry();
    this.providerQuotaTelemetryByProvider.clear();
    this.sessionContextTelemetryBySessionId.clear();
    this.liveSessionRuns.clear();
  }

  /** 現在キャッシュしているプロバイダーの利用枠を返す。未取得なら null。 */
  public getProviderQuotaTelemetry(
    providerId: string,
  ): ProviderQuotaTelemetry | null {
    return this.providerQuotaTelemetryByProvider.get(providerId) ?? null;
  }

  /** 現在追跡する利用枠取得が成功か失敗かにかかわらず、すべて確定するまで待つ。 */
  public async waitForProviderQuotaRefreshes(): Promise<void> {
    await Promise.allSettled([...this.providerQuotaOperations]);
  }

  /** 有効なサービスで利用枠を差し替える。null はキャッシュから削除し、どちらも変更を通知する。 */
  public setProviderQuotaTelemetry(
    providerId: string,
    telemetry: ProviderQuotaTelemetry | null,
  ): void {
    if (this.disposed) return;
    if (telemetry) {
      this.providerQuotaTelemetryByProvider.set(providerId, telemetry);
    } else {
      this.providerQuotaTelemetryByProvider.delete(providerId);
    }

    this.options.onProviderQuotaTelemetryChanged(providerId, telemetry);
  }

  /** 指定プロバイダーの取得を中断し、再試行制限・予約・定期監視・キャッシュをまとめて取り除く。 */
  public clearProviderQuotaTelemetry(providerId: string): void {
    this.providerQuotaRefreshPromises.get(providerId)?.controller.abort();
    this.providerQuotaRefreshPromises.delete(providerId);
    this.providerQuotaRetryNotBefore.delete(providerId);
    this.providerQuotaSuccessNotBefore.delete(providerId);
    clearTimeout(this.providerQuotaTrailingTimers.get(providerId));
    this.providerQuotaTrailingTimers.delete(providerId);
    clearInterval(this.providerQuotaPollingTimers.get(providerId));
    this.providerQuotaPollingTimers.delete(providerId);
    const scheduledTimers =
      this.providerQuotaRefreshTimers.get(providerId) ?? [];
    for (const timer of scheduledTimers) {
      clearTimeout(timer);
    }
    this.providerQuotaRefreshTimers.delete(providerId);
    this.setProviderQuotaTelemetry(providerId, null);
  }

  /** 値だけでなく取得中・予約中のプロバイダーも含め、利用枠の追跡を全件消去する。 */
  public clearAllProviderQuotaTelemetry(): void {
    const providerIds = new Set<string>([
      ...this.providerQuotaTelemetryByProvider.keys(),
      ...this.providerQuotaRefreshPromises.keys(),
      ...this.providerQuotaRefreshTimers.keys(),
      ...this.providerQuotaPollingTimers.keys(),
      ...this.providerQuotaRetryNotBefore.keys(),
      ...this.providerQuotaSuccessNotBefore.keys(),
      ...this.providerQuotaTrailingTimers.keys(),
    ]);
    for (const providerId of providerIds) {
      this.clearProviderQuotaTelemetry(providerId);
    }
  }

  /** 取得時刻が欠けるか不正なら古いと見なし、時刻があれば指定の有効期間と照合する。 */
  public isProviderQuotaTelemetryStale(
    providerId: string,
    staleTtlMs: number,
  ): boolean {
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

  /** 同じプロバイダーの取得を共有し、再取得間隔を守る。追跡対象では取得状態を更新し、古い試行からの結果を採用しない。 */
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
    if (
      Date.now() < (this.providerQuotaSuccessNotBefore.get(providerId) ?? 0)
    ) {
      this.scheduleProviderQuotaTrailingRefresh(providerId, refresh);
      return this.getProviderQuotaTelemetry(providerId);
    }
    clearTimeout(this.providerQuotaTrailingTimers.get(providerId));
    this.providerQuotaTrailingTimers.delete(providerId);
    const controller = new AbortController();
    const attemptStartedAt = Date.now();
    const tracksStatus =
      providerId === "codex" ||
      providerId === "claude" ||
      providerId === "opencode";
    const current = this.getProviderQuotaTelemetry(providerId);
    const operation = {
      controller,
      promise: Promise.resolve<ProviderQuotaTelemetry | null>(null),
    };
    operation.promise = Promise.resolve()
      .then(() =>
        controller.signal.aborted ? null : refresh(controller.signal),
      )
      .then(
        (telemetry) => {
          if (this.providerQuotaRefreshPromises.get(providerId) !== operation)
            return null;
          const next =
            telemetry ??
            (tracksStatus
              ? {
                  provider: providerId,
                  updatedAt: null,
                  snapshots: [],
                  status: "unsupported" as const,
                }
              : null);
          this.providerQuotaRetryNotBefore.delete(providerId);
          if (tracksStatus)
            this.providerQuotaSuccessNotBefore.set(
              providerId,
              Date.now() + PROVIDER_QUOTA_MIN_REFRESH_INTERVAL_MS,
            );
          this.setProviderQuotaTelemetry(providerId, next);
          return next;
        },
        (error: unknown) => {
          if (this.providerQuotaRefreshPromises.get(providerId) !== operation)
            return null;
          if (tracksStatus) {
            this.providerQuotaRetryNotBefore.set(
              providerId,
              attemptStartedAt + PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
            );
            const latest = this.getProviderQuotaTelemetry(providerId);
            this.setProviderQuotaTelemetry(providerId, {
              ...latest,
              provider: providerId,
              updatedAt: latest?.updatedAt ?? null,
              snapshots: latest?.snapshots ?? [],
              status: "error",
            });
          }
          throw error;
        },
      );
    this.providerQuotaRefreshPromises.set(providerId, operation);
    this.providerQuotaOperations.add(operation.promise);
    if (tracksStatus)
      this.setProviderQuotaTelemetry(providerId, {
        ...current,
        provider: providerId,
        updatedAt: current?.updatedAt ?? null,
        snapshots: current?.snapshots ?? [],
        status: "loading",
      });
    try {
      return await operation.promise;
    } finally {
      this.providerQuotaOperations.delete(operation.promise);
      if (this.providerQuotaRefreshPromises.get(providerId) === operation)
        this.providerQuotaRefreshPromises.delete(providerId);
    }
  }

  /** 最後の取得がまだ有効ならキャッシュを返し、期限切れまたは未取得なら更新へ進む。 */
  public async getOrRefreshProviderQuotaTelemetry(
    providerId: string,
    staleTtlMs: number,
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): Promise<ProviderQuotaTelemetry | null> {
    const current = this.getProviderQuotaTelemetry(providerId);
    if (
      current &&
      !this.isProviderQuotaTelemetryStale(providerId, staleTtlMs)
    ) {
      return current;
    }

    return this.refreshProviderQuotaTelemetry(providerId, refresh);
  }

  /** 現在からの遅延時間ごとに一回更新する予定を入れ替える。直近の成功で取得を抑えている間は後続の一件へまとめる。 */
  public scheduleProviderQuotaTelemetryRefresh(
    providerId: string,
    delaysMs: number[],
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): void {
    if (this.disposed) return;
    if (
      Date.now() < (this.providerQuotaSuccessNotBefore.get(providerId) ?? 0)
    ) {
      this.scheduleProviderQuotaTrailingRefresh(providerId, refresh);
      return;
    }
    const existingTimers =
      this.providerQuotaRefreshTimers.get(providerId) ?? [];
    for (const timer of existingTimers) {
      clearTimeout(timer);
    }

    const timers = delaysMs.map((delayMs) =>
      setTimeout(() => {
        void this.refreshProviderQuotaTelemetry(providerId, refresh).catch(
          () => undefined,
        );
      }, delayMs),
    );
    this.providerQuotaRefreshTimers.set(providerId, timers);
  }

  /** 成功後の最短間隔が経過した時点に、一件だけ再取得を予約する。 */
  private scheduleProviderQuotaTrailingRefresh(
    providerId: string,
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): void {
    if (this.providerQuotaTrailingTimers.has(providerId)) return;
    const timer = setTimeout(
      () => {
        if (this.providerQuotaTrailingTimers.get(providerId) !== timer) return;
        this.providerQuotaTrailingTimers.delete(providerId);
        void this.refreshProviderQuotaTelemetry(providerId, refresh).catch(
          () => undefined,
        );
      },
      Math.max(
        0,
        (this.providerQuotaSuccessNotBefore.get(providerId) ?? 0) - Date.now(),
      ),
    );
    this.providerQuotaTrailingTimers.set(providerId, timer);
  }

  /** 指定プロバイダーに定期監視のタイマーが登録済みかを返す。 */
  public hasProviderQuotaPolling(providerId: string): boolean {
    return this.providerQuotaPollingTimers.has(providerId);
  }

  /** プロバイダーごとに一つの定期取得を開始する。初回をすぐ予約し、タイマーだけではプロセスを保持しない。 */
  public startProviderQuotaPolling(
    providerId: string,
    intervalMs: number,
    refresh: (signal: AbortSignal) => Promise<ProviderQuotaTelemetry | null>,
  ): void {
    if (this.disposed || this.hasProviderQuotaPolling(providerId)) return;
    this.scheduleProviderQuotaTelemetryRefresh(providerId, [0], refresh);
    const timer = setInterval(() => {
      void this.refreshProviderQuotaTelemetry(providerId, refresh).catch(
        () => undefined,
      );
    }, intervalMs);
    timer.unref?.();
    this.providerQuotaPollingTimers.set(providerId, timer);
  }

  /** 指定 Session の最後に取得したコンテキスト使用量を返す。未取得なら null。 */
  public getSessionContextTelemetry(
    sessionId: string,
  ): SessionContextTelemetry | null {
    return this.sessionContextTelemetryBySessionId.get(sessionId) ?? null;
  }

  /** コンテキスト使用量を Session ごとに更新または削除し、最新値を通知する。 */
  public setSessionContextTelemetry(
    sessionId: string,
    telemetry: SessionContextTelemetry | null,
  ): void {
    if (telemetry) {
      this.sessionContextTelemetryBySessionId.set(sessionId, telemetry);
    } else {
      this.sessionContextTelemetryBySessionId.delete(sessionId);
    }

    this.options.onSessionContextTelemetryChanged(sessionId, telemetry);
  }

  /** 指定 Session のコンテキスト使用量を消去したことを通知する。 */
  public clearSessionContextTelemetry(sessionId: string): void {
    this.setSessionContextTelemetry(sessionId, null);
  }

  /** 保持中のコンテキスト使用量をすべて取り除き、以前存在した各 Session の消去を通知する。 */
  public clearAllSessionContextTelemetry(): void {
    const sessionIds = Array.from(
      this.sessionContextTelemetryBySessionId.keys(),
    );
    this.sessionContextTelemetryBySessionId.clear();
    for (const sessionId of sessionIds) {
      this.options.onSessionContextTelemetryChanged(sessionId, null);
    }
  }

  /** 指定 Session のライブ実行表示を取得する。未登録なら null。 */
  public getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
    return this.liveSessionRuns.get(sessionId) ?? null;
  }

  /** ライブ実行表示を置き換え、null なら登録を外す。どちらの場合も表示側へ通知する。 */
  public setLiveSessionRun(
    sessionId: string,
    state: LiveSessionRunState | null,
  ): void {
    if (state) {
      this.liveSessionRuns.set(sessionId, state);
    } else {
      this.liveSessionRuns.delete(sessionId);
    }

    this.options.onLiveSessionRunChanged(sessionId, state);
  }

  /** 登録中のライブ状態だけに更新処理を適用する。存在しない Session の表示状態は作らない。 */
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
}
