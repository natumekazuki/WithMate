import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type {
  AuxiliaryCreationContext,
  AuxiliaryCreationResult,
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { resolveSelectedLaunchProviderId } from "../launch/launch-provider-selection.js";
import { LAUNCH_EMPTY_PROVIDER_MESSAGE, LAUNCH_NO_PROVIDER_SELECTED_MESSAGE } from "../launch/launch-feedback.js";

export type AuxiliaryLaunchProviderItem = {
  id: string;
  label: string;
};

export const AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK = LAUNCH_EMPTY_PROVIDER_MESSAGE;
export const AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK = LAUNCH_NO_PROVIDER_SELECTED_MESSAGE;
export const AUXILIARY_LAUNCH_START_FAILED_FEEDBACK = "Auxiliary Session の開始に失敗したよ。";
export const AUXILIARY_LAUNCH_CANCEL_FAILED_FEEDBACK = "Auxiliary Session の作成を取り消せなかったよ。";

export type AuxiliaryLaunchCreationState = {
  request: {
    parentSessionId: string;
    clientRequestId: string;
    creationContext: AuxiliaryCreationContext;
  } | null;
  status: AuxiliaryCreationResult["status"] | null;
};

export function canCancelAuxiliaryLaunchCreation(
  status: AuxiliaryCreationResult["status"] | null | undefined,
): boolean {
  return status === "preparing" || status === "queued";
}

export function isAuxiliaryLaunchCreationActive(
  status: AuxiliaryCreationResult["status"] | null | undefined,
): boolean {
  return status === "preparing" || status === "queued" || status === "committing";
}

export function blocksAuxiliaryLaunchRetry(
  status: AuxiliaryCreationResult["status"] | null | undefined,
): boolean {
  return isAuxiliaryLaunchCreationActive(status) || status === "unknown";
}

export function matchesAuxiliaryLaunchCreationRequest(
  session: Pick<AuxiliarySession, "parentSessionId" | "clientRequestId" | "creationContext">,
  request: AuxiliaryLaunchCreationState["request"],
): boolean {
  return Boolean(
    request
    && session.parentSessionId === request.parentSessionId
    && session.clientRequestId === request.clientRequestId
    && session.creationContext?.generationId === request.creationContext.generationId
    && session.creationContext?.parentIncarnationId === request.creationContext.parentIncarnationId,
  );
}

export function resolveAuxiliaryLaunchCreationFeedback(
  result: AuxiliaryCreationResult,
): string {
  switch (result.status) {
    case "cancelled":
      return "Auxiliary Session の作成を取り消したよ。";
    case "expired":
      return "親セッションが変わったため、作成を終了したよ。";
    case "unknown":
      return "Auxiliary Session の作成結果を確認できないよ。";
    case "failed":
      return AUXILIARY_LAUNCH_START_FAILED_FEEDBACK;
    default:
      return "";
  }
}

export function buildAuxiliaryLaunchProviderItems(
  providers: readonly ModelCatalogProvider[],
  canUseProvider: (provider: ModelCatalogProvider) => boolean,
): AuxiliaryLaunchProviderItem[] {
  return providers.filter(canUseProvider).map((provider) => ({ id: provider.id, label: provider.label }));
}

export type AuxiliaryLaunchSessionDefaults = Pick<
  AuxiliarySession,
  "model" | "reasoningEffort" | "approvalMode" | "codexSandboxMode" | "codexSpeed" | "customAgentName"
>;

export function buildCreateAuxiliarySessionInput(input: {
  parentSessionId: string;
  provider: string;
  runtimeSelection?: CreateAuxiliarySessionInput["runtimeSelection"];
  defaults?: AuxiliaryLaunchSessionDefaults | null;
  clientRequestId?: string;
  creationContext?: AuxiliaryCreationContext;
}): CreateAuxiliarySessionInput {
  if (input.runtimeSelection === "latest-session") {
    return {
      parentSessionId: input.parentSessionId,
      provider: input.provider,
      runtimeSelection: input.runtimeSelection,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.creationContext ? { creationContext: input.creationContext } : {}),
    };
  }
  return {
    parentSessionId: input.parentSessionId,
    provider: input.provider,
    model: input.defaults?.model,
    reasoningEffort: input.defaults?.reasoningEffort,
    approvalMode: input.defaults?.approvalMode,
    codexSandboxMode: input.defaults?.codexSandboxMode,
    ...(input.defaults?.codexSpeed !== undefined ? { codexSpeed: input.defaults.codexSpeed } : {}),
    customAgentName: input.defaults?.customAgentName,
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(input.creationContext ? { creationContext: input.creationContext } : {}),
  };
}

export function resolveAuxiliaryLaunchSessionDefaults(input: {
  providerId: string;
  defaultsProviderId: string | null | undefined;
  defaults: AuxiliaryLaunchSessionDefaults | null | undefined;
}): AuxiliaryLaunchSessionDefaults | null {
  if (!input.defaults || input.providerId !== input.defaultsProviderId) {
    return null;
  }

  return input.defaults;
}

export function resolveAuxiliaryLaunchStartError(input: {
  providerId: string | null | undefined;
  blockedFeedback?: string | null;
}): Error | null {
  if (input.blockedFeedback) {
    return new Error(input.blockedFeedback);
  }
  if (!input.providerId) {
    return new Error(AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK);
  }

  return null;
}

export type AuxiliaryLaunchStartProviderResolution =
  | {
      status: "blocked";
      error: Error;
    }
  | {
      status: "ready";
      providerId: string;
    };

export function resolveAuxiliaryLaunchStartProvider(input: {
  providerId: string | null | undefined;
  blockedFeedback?: string | null;
}): AuxiliaryLaunchStartProviderResolution {
  const providerId = input.providerId;
  const error = resolveAuxiliaryLaunchStartError(input);
  if (error) {
    return {
      status: "blocked",
      error,
    };
  }
  if (!providerId) {
    return {
      status: "blocked",
      error: new Error(AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK),
    };
  }

  return {
    status: "ready",
    providerId,
  };
}

export function resolveAuxiliaryLaunchProviderId(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): string | null {
  return resolveSelectedLaunchProviderId(providers, selectedProviderId);
}

export type AuxiliaryLaunchInitialState = {
  providerId: string | null;
  feedback: string;
};

export function resolveAuxiliaryLaunchCloseState(): { open: false; feedback: string } {
  return {
    open: false,
    feedback: "",
  };
}

export function resolveAuxiliaryLaunchProviderSelectionState(
  providerId: string | null,
): { providerId: string | null; feedback: string } {
  return {
    providerId,
    feedback: "",
  };
}

export type AuxiliaryLaunchDialogStatePatch = {
  open?: boolean;
  providerId?: string | null;
  feedback?: string;
};

export type AuxiliaryLaunchDialogOpenParams = {
  providers: readonly AuxiliaryLaunchProviderItem[];
  selectedProviderId: string | null | undefined;
};

export function createAuxiliaryLaunchDialogOpenHandler(input: {
  canOpen: () => boolean;
  providers: readonly AuxiliaryLaunchProviderItem[];
  getSelectedProviderId: () => string | null | undefined;
  openAuxiliaryLaunchDialog: (params: AuxiliaryLaunchDialogOpenParams) => void;
}): () => void {
  return () => {
    if (!input.canOpen()) {
      return;
    }

    input.openAuxiliaryLaunchDialog({
      providers: input.providers,
      selectedProviderId: input.getSelectedProviderId(),
    });
  };
}

export function createAuxiliaryLaunchDialogCloseHandler(input: {
  canClose?: () => boolean;
  closeAuxiliaryLaunchDialog: () => void;
}): () => void {
  return () => {
    if (input.canClose?.() === false) {
      return;
    }

    input.closeAuxiliaryLaunchDialog();
  };
}

export function createAuxiliaryLaunchProviderSelectHandler(input: {
  selectAuxiliaryLaunchProvider: (providerId: string) => void;
}): (providerId: string) => void {
  return (providerId) => input.selectAuxiliaryLaunchProvider(providerId);
}

export function resolveAuxiliaryLaunchOpenState(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): AuxiliaryLaunchDialogStatePatch {
  const initial = resolveAuxiliaryLaunchInitialState(providers, selectedProviderId);
  return {
    open: true,
    providerId: initial.providerId,
    feedback: initial.feedback,
  };
}

export function resolveAuxiliaryLaunchFeedbackResetState(): Pick<AuxiliaryLaunchDialogStatePatch, "feedback"> {
  return {
    feedback: "",
  };
}

export function resolveAuxiliaryLaunchStartErrorState(
  error: unknown,
): Pick<AuxiliaryLaunchDialogStatePatch, "feedback"> {
  return {
    feedback: resolveAuxiliaryLaunchStartErrorFeedback(error),
  };
}

export function applyAuxiliaryLaunchDialogState(
  setOpen: (next: boolean) => void,
  setProviderId: (next: string | null) => void,
  setFeedback: (next: string) => void,
  state: AuxiliaryLaunchDialogStatePatch,
): void {
  if (state.open !== undefined) {
    setOpen(state.open);
  }
  if (state.providerId !== undefined) {
    setProviderId(state.providerId);
  }
  if (state.feedback !== undefined) {
    setFeedback(state.feedback);
  }
}

export function resolveAuxiliaryLaunchStartErrorFeedback(error: unknown): string {
  return error instanceof Error ? error.message : AUXILIARY_LAUNCH_START_FAILED_FEEDBACK;
}

export function resolveAuxiliaryLaunchInitialState(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): AuxiliaryLaunchInitialState {
  const providerId = resolveAuxiliaryLaunchProviderId(providers, selectedProviderId);
  return {
    providerId,
    feedback: providerId ? "" : AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  };
}
