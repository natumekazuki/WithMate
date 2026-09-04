import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../src/approval-mode.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexSandboxMode,
} from "../src/codex-sandbox-mode.js";
import { DEFAULT_CODEX_SPEED, type CodexSpeed } from "../src/codex-speed.js";
import { DEFAULT_CODEX_REVIEWER, type CodexReviewer } from "../src/codex-reviewer.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
} from "../src/model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import type { SessionSummary } from "../src/session-state.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

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
  getAppSettings(): AppSettings;
  getModelCatalogSnapshot(): ModelCatalogSnapshot;
  getLatestSessionSummaryForProvider(providerId: string): Awaitable<SessionSummary | null>;
};

function resolveEnabledProviderCatalog(
  snapshot: ModelCatalogSnapshot,
  appSettings: AppSettings,
  requestedProviderId?: string | null,
): ModelCatalogProvider {
  const requestedProvider = requestedProviderId ? getProviderCatalog(snapshot.providers, requestedProviderId) : null;
  if (requestedProvider && getProviderAppSettings(appSettings, requestedProvider.id).enabled) {
    return requestedProvider;
  }

  const defaultProvider = snapshot.providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null;
  if (defaultProvider && getProviderAppSettings(appSettings, defaultProvider.id).enabled) {
    return defaultProvider;
  }

  const firstEnabledProvider = snapshot.providers.find((provider) =>
    getProviderAppSettings(appSettings, provider.id).enabled
  );
  if (firstEnabledProvider) {
    return firstEnabledProvider;
  }

  throw new Error("有効な provider が Settings に見つからないよ。");
}

export class SessionLaunchSelectionService {
  constructor(private readonly deps: SessionLaunchSelectionServiceDeps) {}

  async resolve(requestedProviderId?: string | null): Promise<SessionLaunchSelection> {
    const snapshot = this.deps.getModelCatalogSnapshot();
    const provider = resolveEnabledProviderCatalog(
      snapshot,
      this.deps.getAppSettings(),
      requestedProviderId,
    );
    const latestSession = await this.deps.getLatestSessionSummaryForProvider(provider.id);
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
      approvalMode: latestSession?.approvalMode ?? DEFAULT_APPROVAL_MODE,
      codexSandboxMode: latestSession?.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
      codexSpeed: DEFAULT_CODEX_SPEED,
      codexReviewer: DEFAULT_CODEX_REVIEWER,
      customAgentName: latestSession?.customAgentName ?? "",
    };
  }
}
