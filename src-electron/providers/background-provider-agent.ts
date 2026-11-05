import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { resolveBackgroundExecutionOptions } from "../../src-shared/settings/background-settings.js";
import { normalizeAllowedAdditionalDirectories } from "../files/additional-directories.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import type { BackgroundAgentInput } from "./background-call-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderCodingAdapter, ProviderPromptComposition } from "./provider-runtime.js";
import { ProviderTurnError } from "./provider-runtime.js";

export type BackgroundProviderAgentDependencies = {
  getModelCatalog: (input: BackgroundAgentInput) => ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>;
  getAppSettings: () => AppSettings | Promise<AppSettings>;
  getProviderCodingAdapter: (providerId: string) => ProviderCodingAdapter;
  /** Adds host-issued MCP transport to this execution's existing binding and handle. */
  projectBinding: (input: BackgroundAgentInput) => ProviderAgentRuntimeBindingProjection | Promise<ProviderAgentRuntimeBindingProjection>;
};

function unavailable(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** Dispatches an independent execution through the same adapters as interactive turns. */
export function createBackgroundProviderAgent(deps: BackgroundProviderAgentDependencies): (input: BackgroundAgentInput) => Promise<void> {
  return async (input) => {
    input.signal.throwIfAborted();
    let catalog: ModelCatalogSnapshot;
    try { catalog = await deps.getModelCatalog(input); }
    catch (error) { throw unavailable("BACKGROUND_CATALOG_UNAVAILABLE", "背景実行のモデル一覧を取得できません。", error); }
    const availability = resolveBackgroundProviderAvailability(input.selection, catalog);
    if (availability.status !== "available") {
      throw unavailable(availability.status === "not_configured" ? "BACKGROUND_PROVIDER_NOT_CONFIGURED" : availability.code,
        availability.status === "not_configured" ? "背景Providerが未設定です。" : availability.reason);
    }
    let executionOptions;
    try { executionOptions = resolveBackgroundExecutionOptions(input.selection); }
    catch (error) { throw unavailable("BACKGROUND_EXECUTION_OPTIONS_INVALID", "背景実行の権限設定が不正またはProviderに未対応です。", error); }
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
    const systemBodyText = "This is an app-managed background invocation. Registration instructions and reference materials are supplied in the input. There is no human approval or answer channel; process the supplied materials without interactive clarification. Registration is performed by the bound tools; final text output is discarded.";
    const prompt: ProviderPromptComposition = {
      systemBodyText,
      inputBodyText: input.userInput,
      logicalPrompt: { systemText: systemBodyText, inputText: input.userInput, composedText: [systemBodyText, input.userInput].join("\n\n") },
      imagePaths: [],
      additionalDirectories: normalizeAllowedAdditionalDirectories(input.session.workspacePath, input.session.allowedAdditionalDirectories),
    };
    const pendingCleanups: Promise<void>[] = [];
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let interactionFailure: (Error & { code: string }) | undefined;
    const requireInteraction = (kind: "approval" | "elicitation") => {
      if (input.signal.aborted || interactionFailure) return;
      interactionFailure = kind === "approval"
        ? unavailable("BACKGROUND_APPROVAL_REQUIRED", "背景実行に人の承認が必要です。")
        : unavailable("BACKGROUND_ELICITATION_REQUIRED", "背景実行に人の追加回答が必要です。");
      controller.abort();
    };
    try {
      try {
        const result = await adapter.runSessionTurn({
          session: input.session,
          executionTarget: { id: input.continuation.id, threadId: input.continuation.threadId, prompt },
          runtimeOwner: { kind: input.scope.history.source.kind, id: input.continuation.id, incarnationId: input.scope.history.source.incarnationId },
          executionOptions,
          providerCatalog: catalog.providers.find((provider) => provider.id === availability.providerId)!,
          userMessage: input.userInput,
          appSettings,
          attachments: [],
          agentRuntimeBinding: binding,
          signal,
          onCleanupPending: (completion) => { pendingCleanups.push(completion); },
          onApprovalRequest: () => { requireInteraction("approval"); return "deny"; },
          onElicitationRequest: () => { requireInteraction("elicitation"); return { action: "cancel" }; },
        }, (state) => { if (state.threadId) input.continuation.onThreadId(state.threadId); });
        if (result.threadId) input.continuation.onThreadId(result.threadId);
        input.signal.throwIfAborted();
      } catch (error) {
        if (error instanceof ProviderTurnError && error.partialResult.threadId) {
          input.continuation.onThreadId(error.partialResult.threadId);
        }
        throw error;
      } finally {
        try { await adapter.invalidateSessionThread(input.continuation.id); }
        finally { await Promise.all(pendingCleanups); }
      }
    } catch (error) {
      throw interactionFailure ?? error;
    }
    if (interactionFailure) throw interactionFailure;
  };
}
