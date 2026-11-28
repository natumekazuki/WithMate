import {
  DEFAULT_PROVIDER_ID,
  type ModelCatalogProvider,
  type ModelCatalogRequest,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import type {
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "../providers/provider-runtime.js";
import {
  getProviderRuntimeCapabilities,
  resolveProviderCatalogOrThrow,
  resolveProviderCodingAdapter,
  type ProviderRuntimeCapabilities,
} from "../providers/provider-support.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** モデル一覧、プロバイダーごとの実行アダプターと、実行権限の失効操作。 */
type MainProviderFacadeDeps = {
  /** 指定されたプロバイダー・ワークスペースの条件でモデル一覧を取得する。 */
  getModelCatalog(
    request?: ModelCatalogRequest,
  ): Awaitable<ModelCatalogSnapshot>;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
  claudeAdapter: ProviderTurnAdapter;
  opencodeAdapter: ProviderTurnAdapter;
  /** 指定した Session とプロバイダーの組に対する実行権限を失効させる。 */
  revokeProviderExecution?(sessionId: string, providerId: string): void;
  /** アプリで発行したプロバイダー実行権限をすべて失効させる。 */
  revokeAllProviderExecutions?(): void;
};

/** Main からモデル一覧、プロバイダーの機能、スレッドの無効化へアクセスする窓口。 */
export class MainProviderFacade {
  /** プロバイダーを選ぶためのアダプターと、現在の一覧・権限管理への接続を受け取る。 */
  constructor(private readonly deps: MainProviderFacadeDeps) {}

  /** 検索条件をそのまま一覧の取得先へ渡し、スナップショットを返す。 */
  async getModelCatalog(
    request?: ModelCatalogRequest,
  ): Promise<ModelCatalogSnapshot> {
    return this.deps.getModelCatalog(request);
  }

  /** 条件付きの一覧から対象プロバイダーを解決し、見つからなければ失敗を返す。 */
  resolveProviderCatalog(
    providerId: string | null | undefined,
    workspacePath?: string,
  ): Promise<{
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  }> {
    return resolveProviderCatalogOrThrow({
      providerId,
      /** 指定された条件だけを一覧取得に渡し、空の値を絞り込みに使わない。 */
      getModelCatalog: () =>
        this.deps.getModelCatalog({
          ...(providerId ? { providerId } : {}),
          ...(workspacePath ? { workspacePath } : {}),
        }),
    });
  }

  /** 対象プロバイダーを、そのスレッドを扱うコーディングアダプターへ解決する。 */
  getProviderCodingAdapter(
    providerId: string | null | undefined,
  ): ProviderCodingAdapter {
    return resolveProviderCodingAdapter({
      providerId,
      codexAdapter: this.deps.codexAdapter,
      copilotAdapter: this.deps.copilotAdapter,
      claudeAdapter: this.deps.claudeAdapter,
      opencodeAdapter: this.deps.opencodeAdapter,
    });
  }

  /** プロバイダー未指定時だけ既定 ID を使い、各プロバイダーのランタイム対応機能を返す。 */
  getProviderRuntimeCapabilities(
    providerId: string | null | undefined,
  ): ProviderRuntimeCapabilities {
    const resolvedProviderId = providerId ?? DEFAULT_PROVIDER_ID;
    return getProviderRuntimeCapabilities({
      providerId: resolvedProviderId,
    });
  }

  /** 実行権限を失効させず、指定した Session のスレッドだけを無効化する。 */
  async resetProviderSessionThread(
    providerId: string | null | undefined,
    sessionId: string,
  ): Promise<void> {
    await this.getProviderCodingAdapter(providerId).invalidateSessionThread(
      sessionId,
    );
  }

  /** 対象 Session とプロバイダーの実行権限を先に失効させて、スレッドを無効化する。 */
  async invalidateProviderSessionThread(
    providerId: string | null | undefined,
    sessionId: string,
  ): Promise<void> {
    this.deps.revokeProviderExecution?.(
      sessionId,
      providerId ?? DEFAULT_PROVIDER_ID,
    );
    await this.getProviderCodingAdapter(providerId).invalidateSessionThread(
      sessionId,
    );
  }

  /** 実行権限をすべて失効させた後、全プロバイダーのスレッド無効化を並行して待つ。 */
  async invalidateAllProviderSessionThreads(): Promise<void> {
    this.deps.revokeAllProviderExecutions?.();
    await Promise.all([
      this.deps.codexAdapter.invalidateAllSessionThreads(),
      this.deps.copilotAdapter.invalidateAllSessionThreads(),
      this.deps.claudeAdapter.invalidateAllSessionThreads(),
      this.deps.opencodeAdapter.invalidateAllSessionThreads(),
    ]);
  }
}
