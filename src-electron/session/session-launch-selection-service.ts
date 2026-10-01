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
import { isProviderSupported, requireSupportedProviderId } from "../providers/provider-support.js";

export type SessionLaunchSelection = {
  provider: string;
  catalogRevision: number;
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
  getModelCatalogSnapshot(): Awaitable<ModelCatalogSnapshot>;
  getLatestSessionSummaryForProvider(providerId: string): Awaitable<SessionSummary | null>;
  getCurrentExecutionOptions?(providerId: string): SessionExecutionOptions | null;
};

function resolveEnabledProviderCatalog(
  snapshot: ModelCatalogSnapshot,
  appSettings: AppSettings,
  requestedProviderId?: string | null,
): ModelCatalogProvider {
  const requestedId = requestedProviderId != null ? requireSupportedProviderId(requestedProviderId) : null;
  const requestedProvider = requestedId != null
    ? snapshot.providers.find((provider) => provider.id === requestedId)
    : null;
  if (requestedProviderId != null && !requestedProvider) {
    throw new Error(`Provider ${requestedProviderId} is not available in the model catalog.`);
  }
  if (requestedProvider && getProviderAppSettings(appSettings, requestedProvider.id).enabled) {
    return requestedProvider;
  }

  const defaultProvider = snapshot.providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null;
  if (defaultProvider && getProviderAppSettings(appSettings, defaultProvider.id).enabled) {
    return defaultProvider;
  }

  const firstEnabledProvider = snapshot.providers.find((provider) =>
    isProviderSupported(provider.id) && getProviderAppSettings(appSettings, provider.id).enabled
  );
  if (firstEnabledProvider) {
    return firstEnabledProvider;
  }

  throw new Error("No enabled supported provider is available in Settings.");
}

export class SessionLaunchSelectionService {
  constructor(private readonly deps: SessionLaunchSelectionServiceDeps) {}

  async resolve(requestedProviderId?: string | null): Promise<SessionLaunchSelection> {
    const snapshot = await this.deps.getModelCatalogSnapshot();
    const provider = resolveEnabledProviderCatalog(
      snapshot,
      await this.deps.getAppSettings(),
      requestedProviderId,
    );
    const latestSession = this.deps.getCurrentExecutionOptions?.(provider.id)
      ?? await this.deps.getLatestSessionSummaryForProvider(provider.id);
    const modelSelection = resolveModelSelection(
      provider,
      latestSession?.model ?? provider.defaultModelId,
      latestSession?.reasoningEffort ?? provider.defaultReasoningEffort,
    );

    return {
      provider: provider.id,
      catalogRevision: snapshot.revision,
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
