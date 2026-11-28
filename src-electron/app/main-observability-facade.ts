import type {
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import {
  getProviderAppSettings,
  type AppSettings,
  type ProviderAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { ProviderCodingAdapter } from "../providers/provider-runtime.js";
import { fetchProviderQuotaTelemetry } from "../providers/provider-support.js";
import {
  SessionObservabilityService,
  PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
} from "../session/session-observability-service.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** 観測状態へのアクセスと、Provider 利用枠の取得に必要な依存。 */
type MainObservabilityFacadeDeps = {
  /** 稼働中の観測サービスを取得する。 */
  getSessionObservabilityService(): SessionObservabilityService;
  /** 利用枠の取得時点で有効なアプリ設定を読む。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** 指定された Provider のアダプターを取得する。 */
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
  providerQuotaStaleTtlMs: number;
};

/** Main で利用枠の更新方針を適用し、Session の観測状態にアクセスする窓口。 */
export class MainObservabilityFacade {
  private readonly quotaSettings = new Map<string, ProviderAppSettings>();
  /** 観測サービスと利用枠取得に必要な依存を受け取る。 */
  constructor(private readonly deps: MainObservabilityFacadeDeps) {}

  /** 定期取得対象の設定を反映し、有効状態または認証キーが変わった Provider の取得済み利用枠を消去する。 */
  configureProviderQuotaPolling(settings: AppSettings): void {
    const service = this.deps.getSessionObservabilityService();
    for (const providerId of ["codex", "claude", "opencode"]) {
      const next = getProviderAppSettings(settings, providerId);
      const previous = this.quotaSettings.get(providerId);
      if (
        !previous ||
        previous.enabled !== next.enabled ||
        previous.apiKey !== next.apiKey
      ) {
        service.clearProviderQuotaTelemetry(providerId);
      }
      this.quotaSettings.set(providerId, { ...next });
      if (next.enabled) {
        service.startProviderQuotaPolling(
          providerId,
          PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
          (signal) => this.fetchQuota(providerId, signal),
        );
      }
    }
  }

  /** 現在のアプリ設定とアダプターを使い、中止可能な利用枠取得を行う。 */
  private fetchQuota(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ProviderQuotaTelemetry | null> {
    return fetchProviderQuotaTelemetry({
      providerId,
      signal,
      /** 要求時点のアプリ設定を取得処理に渡す。 */
      getAppSettings: () => this.deps.getAppSettings(),
      /** 指定された Provider のアダプターを取得処理に渡す。 */
      getProviderCodingAdapter: (nextProviderId) =>
        this.deps.getProviderCodingAdapter(nextProviderId),
    });
  }

  /** 外部へ問い合わせず、保持している利用枠を返す。 */
  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
    return this.deps
      .getSessionObservabilityService()
      .getProviderQuotaTelemetry(providerId);
  }

  /** 無効と分かっている Provider への書き込みを無視し、それ以外の利用枠を更新する。 */
  setProviderQuotaTelemetry(
    providerId: string,
    telemetry: ProviderQuotaTelemetry | null,
  ): void {
    if (this.quotaSettings.get(providerId)?.enabled === false) return;
    this.deps
      .getSessionObservabilityService()
      .setProviderQuotaTelemetry(providerId, telemetry);
  }

  /** 指定された Provider の利用枠を観測サービスから消去する。 */
  clearProviderQuotaTelemetry(providerId: string): void {
    this.deps
      .getSessionObservabilityService()
      .clearProviderQuotaTelemetry(providerId);
  }

  /** 観測サービスに保持されている全 Provider の利用枠を消去する。 */
  clearAllProviderQuotaTelemetry(): void {
    this.deps.getSessionObservabilityService().clearAllProviderQuotaTelemetry();
  }

  /** 利用枠がなければ古いとみなし、あれば Provider ごとの取得時刻を有効期間と照合する。 */
  isProviderQuotaTelemetryStale(
    telemetry: ProviderQuotaTelemetry | null,
  ): boolean {
    return telemetry
      ? this.deps
          .getSessionObservabilityService()
          .isProviderQuotaTelemetryStale(
            telemetry.provider,
            this.deps.providerQuotaStaleTtlMs,
          )
      : true;
  }

  /** 無効と分かっている Provider では取得せず、それ以外は観測サービスに更新を依頼する。 */
  async refreshProviderQuotaTelemetry(
    providerId: string,
  ): Promise<ProviderQuotaTelemetry | null> {
    if (this.quotaSettings.get(providerId)?.enabled === false) return null;
    return this.deps
      .getSessionObservabilityService()
      .refreshProviderQuotaTelemetry(providerId, (signal) =>
        this.fetchQuota(providerId, signal),
      );
  }

  /** 定期取得対象とキャッシュ限定の要求では保持値を返し、それ以外は有効期間に応じて取得する。 */
  async getOrRefreshProviderQuotaTelemetry(
    providerId: string,
    options?: { cacheOnly?: boolean },
  ): Promise<ProviderQuotaTelemetry | null> {
    if (
      options?.cacheOnly ||
      providerId === "codex" ||
      providerId === "claude" ||
      providerId === "opencode"
    )
      return this.getProviderQuotaTelemetry(providerId);
    return this.deps
      .getSessionObservabilityService()
      .getOrRefreshProviderQuotaTelemetry(
        providerId,
        this.deps.providerQuotaStaleTtlMs,
        (signal) => this.fetchQuota(providerId, signal),
      );
  }

  /** 無効と分かっていない Provider の利用枠更新を指定の遅延ごとに予約する。 */
  scheduleProviderQuotaTelemetryRefresh(
    providerId: string,
    delaysMs: number[],
  ): void {
    if (this.quotaSettings.get(providerId)?.enabled === false) return;
    this.deps
      .getSessionObservabilityService()
      .scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs, (signal) =>
        this.fetchQuota(providerId, signal),
      );
  }

  /** 指定された Session について最後に記録されたコンテキスト使用量を返す。 */
  getSessionContextTelemetry(
    sessionId: string,
  ): SessionContextTelemetry | null {
    return this.deps
      .getSessionObservabilityService()
      .getSessionContextTelemetry(sessionId);
  }

  /** 指定された Session のコンテキスト使用量を観測サービスに反映する。 */
  setSessionContextTelemetry(
    sessionId: string,
    telemetry: SessionContextTelemetry | null,
  ): void {
    this.deps
      .getSessionObservabilityService()
      .setSessionContextTelemetry(sessionId, telemetry);
  }

  /** 指定された Session のコンテキスト使用量を消去する。 */
  clearSessionContextTelemetry(sessionId: string): void {
    this.deps
      .getSessionObservabilityService()
      .clearSessionContextTelemetry(sessionId);
  }

  /** すべての Session のコンテキスト使用量を消去する。 */
  clearAllSessionContextTelemetry(): void {
    this.deps
      .getSessionObservabilityService()
      .clearAllSessionContextTelemetry();
  }

  /** 指定された Session の実行中状態を返し、保持していなければ null を返す。 */
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
    return this.deps
      .getSessionObservabilityService()
      .getLiveSessionRun(sessionId);
  }

  /** 指定された Session の実行中状態を設定し、null なら取り除く。 */
  setLiveSessionRun(
    sessionId: string,
    state: LiveSessionRunState | null,
  ): void {
    this.deps
      .getSessionObservabilityService()
      .setLiveSessionRun(sessionId, state);
  }

  /** 指定された Session の保持中の実行状態に更新処理を適用する。 */
  updateLiveSessionRun(
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ): LiveSessionRunState | null {
    return this.deps
      .getSessionObservabilityService()
      .updateLiveSessionRun(sessionId, recipe);
  }
}
