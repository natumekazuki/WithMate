import type { ApprovalMode } from "../../src-shared/settings/approval-mode.js";
import { getDefaultApprovalModeForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexSandboxMode,
} from "../../src-shared/settings/codex-sandbox-mode.js";
import {
  DEFAULT_CODEX_SPEED,
  type CodexSpeed,
} from "../../src-shared/settings/codex-speed.js";
import {
  DEFAULT_CODEX_REVIEWER,
  type CodexReviewer,
} from "../../src-shared/settings/codex-reviewer.js";
import {
  DEFAULT_PROVIDER_ID,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
} from "../../src-shared/settings/model-catalog.js";
import {
  getProviderAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import type { SessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import { requireSupportedProviderId } from "../providers/provider-support.js";

/** Session を新しく起動する際のモデル・推論設定と承認や隔離の選択値。 */
export type SessionLaunchSelection = {
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  codexReviewer: CodexReviewer;
  withMateReviewerExplicit?: true;
  customAgentName: string;
};

/** 起動設定を現在の設定・モデル一覧・最後に選ばれた実行条件から解決するための読み取り境界。 */
type SessionLaunchSelectionServiceDeps = {
  /** 現在のプロバイダー有効状態と、モデルの許可設定を取得する。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** 指定された作業場所のモデル一覧を取得する。必要に応じて特定プロバイダーの探索結果を要求できる。 */
  getModelCatalogSnapshot(
    workspacePath?: string,
    providerId?: string,
  ): Awaitable<ModelCatalogSnapshot>;
  /** 指定プロバイダーの保存済み最新 Session を、起動時の既定候補として取得する。 */
  getLatestSessionSummaryForProvider(
    providerId: string,
  ): Awaitable<SessionSummary | null>;
  /** 指定プロバイダーの現在の UI 選択があれば、保存済みの選択より先に使う。 */
  getCurrentExecutionOptions?(
    providerId: string,
  ): SessionExecutionOptions | null;
};

/** 指定または既定のプロバイダーが対応済みかつ有効であり、カタログに載っていることを確認する。 */
function resolveEnabledProviderCatalog(
  snapshot: ModelCatalogSnapshot,
  appSettings: AppSettings,
  requestedProviderId?: string | null,
): ModelCatalogProvider {
  const providerId = requireSupportedProviderId(
    requestedProviderId ?? DEFAULT_PROVIDER_ID,
  );
  const provider = snapshot.providers.find((entry) => entry.id === providerId);
  if (!provider)
    throw new Error(`Provider ${providerId} model discovery is unavailable.`);
  if (!getProviderAppSettings(appSettings, providerId).enabled) {
    throw new Error(`Provider ${providerId} is disabled in Settings.`);
  }
  return provider;
}

/** 新しい Session の選択値を決め、無効な提供元やモデルでの起動を防ぐ。 */
export class SessionLaunchSelectionService {
  /** 設定・カタログ・現在値と保存済み選択の読み取り先を受け取る。 */
  constructor(private readonly deps: SessionLaunchSelectionServiceDeps) {}

  /** 現在値、保存済み選択、入力に保存された既定値の順で同じプロバイダーの候補を参照し、なければカタログから既定を解決する。 */
  async resolve(
    requestedProviderId?: string | null,
    workspacePath?: string,
    capturedDefaults?: SessionLaunchSelection,
  ): Promise<SessionLaunchSelection> {
    const snapshot = await this.deps.getModelCatalogSnapshot(workspacePath);
    let provider = resolveEnabledProviderCatalog(
      snapshot,
      await this.deps.getAppSettings(),
      requestedProviderId,
    );
    const latestSession =
      this.deps.getCurrentExecutionOptions?.(provider.id) ??
      (await this.deps.getLatestSessionSummaryForProvider(provider.id)) ??
      (capturedDefaults?.provider === provider.id ? capturedDefaults : null);
    if (!latestSession?.model) {
      provider = resolveEnabledProviderCatalog(
        await this.deps.getModelCatalogSnapshot(workspacePath, provider.id),
        await this.deps.getAppSettings(),
        provider.id,
      );
      if (!provider.defaultModelId) {
        throw new Error(
          `Provider ${provider.id} has no available model. Complete model discovery before creating a Session.`,
        );
      }
    }
    const modelSelection = resolveModelSelection(
      provider,
      latestSession?.model ?? provider.defaultModelId,
      latestSession?.reasoningEffort ?? provider.defaultReasoningEffort,
    );
    assertModelEnabled(
      (await this.deps.getAppSettings()).modelAvailability,
      provider.id,
      modelSelection.resolvedModel,
    );

    return {
      provider: provider.id,
      model: modelSelection.resolvedModel,
      reasoningEffort: modelSelection.resolvedReasoningEffort,
      approvalMode:
        latestSession?.approvalMode ??
        getDefaultApprovalModeForProvider(provider.id),
      codexSandboxMode:
        latestSession?.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
      codexSpeed: latestSession?.codexSpeed ?? DEFAULT_CODEX_SPEED,
      codexReviewer: latestSession?.codexReviewer ?? DEFAULT_CODEX_REVIEWER,
      ...(latestSession?.withMateReviewerExplicit
        ? { withMateReviewerExplicit: true }
        : {}),
      customAgentName: latestSession?.customAgentName ?? "",
    };
  }
}
