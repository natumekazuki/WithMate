import type { ApprovalMode } from "../../src-shared/settings/approval-mode.js";
import { getDefaultApprovalModeForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexSandboxMode,
} from "../../src-shared/settings/codex-sandbox-mode.js";
import { DEFAULT_CODEX_SPEED, type CodexSpeed } from "../../src-shared/settings/codex-speed.js";
import { DEFAULT_CODEX_REVIEWER, type CodexReviewer } from "../../src-shared/settings/codex-reviewer.js";
import {
  DEFAULT_PROVIDER_ID,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
} from "../../src-shared/settings/model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { SessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import { requireSupportedProviderId } from "../providers/provider-support.js";

export type SessionLaunchSelection = {
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  codexReviewer: CodexReviewer;
  customAgentName: string;
};

type SessionLaunchSelectionServiceDeps = {
  getAppSettings(): Awaitable<AppSettings>;
  getModelCatalogSnapshot(workspacePath?: string, providerId?: string): Awaitable<ModelCatalogSnapshot>;
  getLatestSessionSummaryForProvider(providerId: string): Awaitable<SessionSummary | null>;
  getCurrentExecutionOptions?(providerId: string): SessionExecutionOptions | null;
};

function resolveEnabledProviderCatalog(
  snapshot: ModelCatalogSnapshot,
  appSettings: AppSettings,
  requestedProviderId?: string | null,
): ModelCatalogProvider {
  const providerId = requireSupportedProviderId(requestedProviderId ?? DEFAULT_PROVIDER_ID);
  const provider = snapshot.providers.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Provider ${providerId} model discovery is unavailable.`);
  if (!getProviderAppSettings(appSettings, providerId).enabled) {
    throw new Error(`Provider ${providerId} is disabled in Settings.`);
  }
  return provider;
}

export class SessionLaunchSelectionService {
  constructor(private readonly deps: SessionLaunchSelectionServiceDeps) {}

  async resolve(requestedProviderId?: string | null, workspacePath?: string, capturedDefaults?: SessionLaunchSelection): Promise<SessionLaunchSelection> {
    const snapshot = await this.deps.getModelCatalogSnapshot(workspacePath);
    let provider = resolveEnabledProviderCatalog(
      snapshot,
      await this.deps.getAppSettings(),
      requestedProviderId,
    );
    const latestSession = this.deps.getCurrentExecutionOptions?.(provider.id)
      ?? await this.deps.getLatestSessionSummaryForProvider(provider.id)
      ?? (capturedDefaults?.provider === provider.id ? capturedDefaults : null);
    if (!latestSession?.model) {
      provider = resolveEnabledProviderCatalog(
        await this.deps.getModelCatalogSnapshot(workspacePath, provider.id),
        await this.deps.getAppSettings(),
        provider.id,
      );
      if (!provider.defaultModelId) {
        throw new Error(`Provider ${provider.id} has no available model. Complete model discovery before creating a Session.`);
      }
    }
    const modelSelection = resolveModelSelection(
      provider,
      latestSession?.model ?? provider.defaultModelId,
      latestSession?.reasoningEffort ?? provider.defaultReasoningEffort,
    );

    return {
      provider: provider.id,
      model: modelSelection.resolvedModel,
      reasoningEffort: modelSelection.resolvedReasoningEffort,
      approvalMode: latestSession?.approvalMode ?? getDefaultApprovalModeForProvider(provider.id),
      codexSandboxMode: latestSession?.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
      codexSpeed: latestSession?.codexSpeed ?? DEFAULT_CODEX_SPEED,
      codexReviewer: latestSession?.codexReviewer ?? DEFAULT_CODEX_REVIEWER,
      customAgentName: latestSession?.customAgentName ?? "",
    };
  }
}
