import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAllowedAdditionalDirectories } from "../files/additional-directories.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import type { BackgroundAgentInput } from "./background-call-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderCodingAdapter, ProviderPromptComposition } from "./provider-runtime.js";

export type BackgroundProviderAgentDependencies = {
  getModelCatalog: (input: BackgroundAgentInput) => ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>;
  getAppSettings: () => AppSettings | Promise<AppSettings>;
  getProviderCodingAdapter: (providerId: string) => ProviderCodingAdapter;
  /** Adds host-issued MCP transport to this execution's existing binding and handle. */
  projectBinding: (input: BackgroundAgentInput) => ProviderAgentRuntimeBindingProjection | Promise<ProviderAgentRuntimeBindingProjection>;
};

function unavailable(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Dispatches an independent execution through the same adapters as interactive turns. */
export function createBackgroundProviderAgent(deps: BackgroundProviderAgentDependencies): (input: BackgroundAgentInput) => Promise<void> {
  return async (input) => {
    input.signal.throwIfAborted();
    let catalog: ModelCatalogSnapshot;
    try { catalog = await deps.getModelCatalog(input); }
    catch { throw unavailable("BACKGROUND_CATALOG_UNAVAILABLE", "背景実行のモデル一覧を取得できません。"); }
    const availability = resolveBackgroundProviderAvailability(input.selection, catalog);
    if (availability.status !== "available") {
      throw unavailable(availability.status === "not_configured" ? "BACKGROUND_PROVIDER_NOT_CONFIGURED" : availability.code,
        availability.status === "not_configured" ? "背景Providerが未設定です。" : availability.reason);
    }
    const binding = await deps.projectBinding(input);
    if (binding.bindingId !== input.binding.bindingId || binding.bindingReference !== input.binding.bindingReference
      || binding.executionGeneration !== input.binding.executionGeneration || binding.providerId !== availability.providerId
      || !binding.background || binding.transport !== "env" || binding.turnCapability !== input.handle.capability
      || !binding.memoryRuntimeOwner || !binding.managedMcp?.sessionHistoryUrl) {
      throw unavailable("BACKGROUND_BINDING_INVALID", "背景実行に対応した同一bindingの接続が必要です。");
    }
    const appSettings = await deps.getAppSettings();
    input.signal.throwIfAborted();
    const adapter = deps.getProviderCodingAdapter(availability.providerId);
    const systemBodyText = "This is an app-managed background invocation. The input contains registration instructions and reference materials, not a conversation persona. Registration is performed by the bound tools; text output is discarded.";
    const prompt: ProviderPromptComposition = {
      systemBodyText,
      inputBodyText: input.userInput,
      logicalPrompt: { systemText: systemBodyText, inputText: input.userInput, composedText: [systemBodyText, input.userInput].join("\n\n") },
      imagePaths: [],
      additionalDirectories: normalizeAllowedAdditionalDirectories(input.session.workspacePath, input.session.allowedAdditionalDirectories),
    };
    const pendingCleanups: Promise<void>[] = [];
    try {
      await adapter.runSessionTurn({
        session: input.session,
        executionTarget: { id: binding.bindingId, threadId: null, prompt },
        runtimeOwner: { kind: input.scope.history.source.kind, id: binding.bindingId, incarnationId: binding.executionGeneration },
        executionOptions: { ...captureSessionExecutionOptions(input.session),
          model: availability.modelId, reasoningEffort: input.selection.reasoningEffort ?? "" },
        providerCatalog: catalog.providers.find((provider) => provider.id === availability.providerId)!,
        userMessage: input.userInput,
        appSettings,
        attachments: [],
        agentRuntimeBinding: binding,
        signal: input.signal,
        onCleanupPending: (completion) => { pendingCleanups.push(completion); },
        // No foreground callbacks: existing adapter approval/question handling denies
        // requests which require an interactive decision, without changing native policy.
      });
      input.signal.throwIfAborted();
    } finally {
      try { await adapter.invalidateSessionThread(binding.bindingId); }
      finally { await Promise.all(pendingCleanups); }
    }
  };
}
