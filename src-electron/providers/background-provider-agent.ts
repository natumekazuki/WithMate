import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { resolveBackgroundExecutionOptions } from "../../src-shared/settings/background-settings.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import type { BackgroundAgentInput } from "./background-call-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderCodingAdapter, RunSessionTurnInput } from "./provider-runtime.js";
import { ProviderTurnError } from "./provider-runtime.js";
import { composeProviderPrompt } from "./provider-prompt.js";

export type BackgroundProviderAgentDependencies = {
  getModelCatalog: (input: BackgroundAgentInput) => ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>;
  getAppSettings: () => AppSettings | Promise<AppSettings>;
  getProviderCodingAdapter: (providerId: string) => ProviderCodingAdapter;
  /** Adds host-issued MCP transport to this execution's existing binding and handle. */
  projectBinding: (input: BackgroundAgentInput) => ProviderAgentRuntimeBindingProjection | Promise<ProviderAgentRuntimeBindingProjection>;
  resolvePromptContext?: (input: BackgroundAgentInput, settings: AppSettings) => Promise<Pick<RunSessionTurnInput,
    "session" | "sessionFolderPath" | "characterContext" | "conversationTimingContext">>;
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
        const turnInput: RunSessionTurnInput = {
          session: input.session,
          ...await deps.resolvePromptContext?.(input, appSettings),
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
        };
        signal.throwIfAborted();
        const commonPrompt = composeProviderPrompt(turnInput);
        const systemBodyText = [commonPrompt.systemBodyText,
          "This is an app-managed background invocation. The input supplies the purpose instructions and captured scope. There is no human approval or answer channel. Final text output is discarded; state changes are performed by the bound tools.",
        ].filter(Boolean).join("\n\n");
        const prompt = { ...commonPrompt, systemBodyText, logicalPrompt: {
          systemText: systemBodyText, inputText: commonPrompt.inputBodyText,
          composedText: [systemBodyText, commonPrompt.inputBodyText].join("\n\n"),
        } };
        turnInput.executionTarget = { id: input.continuation.id, threadId: input.continuation.threadId, prompt };
        const result = await adapter.runSessionTurn(turnInput, (state) => { if (state.threadId) input.continuation.onThreadId(state.threadId); });
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
