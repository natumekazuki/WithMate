import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type {
  AuxiliaryCreationContext,
  AuxiliaryCreationResult,
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { resolveSelectedLaunchProviderId } from "../launch/launch-provider-selection.js";
import {
  LAUNCH_EMPTY_PROVIDER_MESSAGE,
  LAUNCH_NO_PROVIDER_SELECTED_MESSAGE,
} from "../launch/launch-feedback.js";

/** 起動ダイアログの候補に表示するプロバイダーの識別子と名称。 */
export type AuxiliaryLaunchProviderItem = {
  id: string;
  label: string;
};

/** 利用できるプロバイダー候補がない場合の案内。 */
export const AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK =
  LAUNCH_EMPTY_PROVIDER_MESSAGE;
/** プロバイダーを選ばず作成を開始しようとした場合の案内。 */
export const AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK =
  LAUNCH_NO_PROVIDER_SELECTED_MESSAGE;
/** 作成の失敗が確定した場合や、詳細を取得できない開始エラーの案内。 */
export const AUXILIARY_LAUNCH_START_FAILED_FEEDBACK =
  "Could not start the Auxiliary session.";
/** 取消操作の失敗を知らせる案内。 */
export const AUXILIARY_LAUNCH_CANCEL_FAILED_FEEDBACK =
  "Could not cancel Auxiliary session creation.";

/** 作成結果を照合するための要求識別情報と、直近に確認した進行状態。 */
export type AuxiliaryLaunchCreationState = {
  request: {
    parentSessionId: string;
    clientRequestId: string;
    creationContext: AuxiliaryCreationContext;
  } | null;
  status: AuxiliaryCreationResult["status"] | null;
};

/** 準備中または待機中の作成に限り、取り消せると判定する。 */
export function canCancelAuxiliaryLaunchCreation(
  status: AuxiliaryCreationResult["status"] | null | undefined,
): boolean {
  return status === "preparing" || status === "queued";
}

/** 準備・待機・確定処理のいずれかが進行中かを判定する。 */
export function isAuxiliaryLaunchCreationActive(
  status: AuxiliaryCreationResult["status"] | null | undefined,
): boolean {
  return (
    status === "preparing" || status === "queued" || status === "committing"
  );
}

/** 作成が進行中か結果不明の場合は、別の要求で起動し直さない。 */
export function blocksAuxiliaryLaunchRetry(
  status: AuxiliaryCreationResult["status"] | null | undefined,
): boolean {
  return isAuxiliaryLaunchCreationActive(status) || status === "unknown";
}

/** 親の識別子・世代とクライアント側の要求識別子を照合し、別の作成結果を除外する。 */
export function matchesAuxiliaryLaunchCreationRequest(
  session: Pick<
    AuxiliarySession,
    "parentSessionId" | "clientRequestId" | "creationContext"
  >,
  request: AuxiliaryLaunchCreationState["request"],
): boolean {
  return Boolean(
    request &&
    session.parentSessionId === request.parentSessionId &&
    session.clientRequestId === request.clientRequestId &&
    session.creationContext?.generationId ===
      request.creationContext.generationId &&
    session.creationContext?.parentIncarnationId ===
      request.creationContext.parentIncarnationId,
  );
}

/** 取消・期限切れ・結果不明・失敗を、それぞれ起動ダイアログの案内に変換する。 */
export function resolveAuxiliaryLaunchCreationFeedback(
  result: AuxiliaryCreationResult,
): string {
  switch (result.status) {
    case "cancelled":
      return "Auxiliary session creation was canceled.";
    case "expired":
      return "Creation ended because the parent session changed.";
    case "unknown":
      return "Could not confirm the Auxiliary session creation result.";
    case "failed":
      return AUXILIARY_LAUNCH_START_FAILED_FEEDBACK;
    default:
      return "";
  }
}

/** カタログから利用条件を満たすプロバイダーだけを選択候補にする。 */
export function buildAuxiliaryLaunchProviderItems(
  providers: readonly ModelCatalogProvider[],
  canUseProvider: (provider: ModelCatalogProvider) => boolean,
): AuxiliaryLaunchProviderItem[] {
  return providers
    .filter(canUseProvider)
    .map((provider) => ({ id: provider.id, label: provider.label }));
}

/** 同一プロバイダーで作成するときに引き継げる実行設定。 */
export type AuxiliaryLaunchSessionDefaults = Pick<
  AuxiliarySession,
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "codexSandboxMode"
  | "codexSpeed"
  | "customAgentName"
>;

/** 作成要求を組み立てる。最新会話から設定を解決する指定では、画面側の既定実行設定を送らない。 */
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
      ...(input.clientRequestId
        ? { clientRequestId: input.clientRequestId }
        : {}),
      ...(input.creationContext
        ? { creationContext: input.creationContext }
        : {}),
    };
  }
  return {
    parentSessionId: input.parentSessionId,
    provider: input.provider,
    model: input.defaults?.model,
    reasoningEffort: input.defaults?.reasoningEffort,
    approvalMode: input.defaults?.approvalMode,
    codexSandboxMode: input.defaults?.codexSandboxMode,
    ...(input.defaults?.codexSpeed !== undefined
      ? { codexSpeed: input.defaults.codexSpeed }
      : {}),
    customAgentName: input.defaults?.customAgentName,
    ...(input.clientRequestId
      ? { clientRequestId: input.clientRequestId }
      : {}),
    ...(input.creationContext
      ? { creationContext: input.creationContext }
      : {}),
  };
}

/** 起動先と既定値のプロバイダーが一致する場合だけ実行設定を引き継ぐ。 */
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

/** 起動を妨げる理由を判定し、明示の理由をプロバイダー未選択より優先する。 */
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

/** 起動できる場合のプロバイダー識別子、または起動できない理由。 */
export type AuxiliaryLaunchStartProviderResolution =
  | {
      status: "blocked";
      error: Error;
    }
  | {
      status: "ready";
      providerId: string;
    };

/** 起動条件を確認し、要求に使用できるプロバイダーか、表示すべきエラーを返す。 */
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

/** 現在の選択が候補にあれば維持し、なければ先頭候補、候補がなければ null を返す。 */
export function resolveAuxiliaryLaunchProviderId(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): string | null {
  return resolveSelectedLaunchProviderId(providers, selectedProviderId);
}

/** 起動ダイアログを開くときのプロバイダー選択と案内。 */
export type AuxiliaryLaunchInitialState = {
  providerId: string | null;
  feedback: string;
};

/** ダイアログを閉じ、表示していた案内を消すための状態を返す。 */
export function resolveAuxiliaryLaunchCloseState(): {
  open: false;
  feedback: string;
} {
  return {
    open: false,
    feedback: "",
  };
}

/** プロバイダー選択を更新し、以前の選択で表示した案内を消す。 */
export function resolveAuxiliaryLaunchProviderSelectionState(
  providerId: string | null,
): { providerId: string | null; feedback: string } {
  return {
    providerId,
    feedback: "",
  };
}

/** ダイアログの状態差分。省略した項目は維持し、プロバイダーの null は選択を解除する。 */
export type AuxiliaryLaunchDialogStatePatch = {
  open?: boolean;
  providerId?: string | null;
  feedback?: string;
};

/** ダイアログを開く際の利用候補と優先するプロバイダー。 */
export type AuxiliaryLaunchDialogOpenParams = {
  providers: readonly AuxiliaryLaunchProviderItem[];
  selectedProviderId: string | null | undefined;
};

/** 操作時に起動可否を確認し、許可されていればその時点の選択を開く処理へ渡す。 */
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

/** 閉じることを明示的に禁止されていない場合だけ、ダイアログを閉じる処理を実行する。 */
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

/** 選択操作で指定されたプロバイダー識別子をダイアログ状態の更新へ渡す。 */
export function createAuxiliaryLaunchProviderSelectHandler(input: {
  selectAuxiliaryLaunchProvider: (providerId: string) => void;
}): (providerId: string) => void {
  return (providerId) => input.selectAuxiliaryLaunchProvider(providerId);
}

/** ダイアログを開き、候補に応じた初期プロバイダーと案内を反映する差分を返す。 */
export function resolveAuxiliaryLaunchOpenState(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): AuxiliaryLaunchDialogStatePatch {
  const initial = resolveAuxiliaryLaunchInitialState(
    providers,
    selectedProviderId,
  );
  return {
    open: true,
    providerId: initial.providerId,
    feedback: initial.feedback,
  };
}

/** ダイアログの開閉や選択は変えず、案内だけを消す差分を返す。 */
export function resolveAuxiliaryLaunchFeedbackResetState(): Pick<
  AuxiliaryLaunchDialogStatePatch,
  "feedback"
> {
  return {
    feedback: "",
  };
}

/** 作成開始時のエラーを、案内だけを変更する状態差分に変換する。 */
export function resolveAuxiliaryLaunchStartErrorState(
  error: unknown,
): Pick<AuxiliaryLaunchDialogStatePatch, "feedback"> {
  return {
    feedback: resolveAuxiliaryLaunchStartErrorFeedback(error),
  };
}

/** 状態差分に指定された項目だけを更新し、省略された状態を保持する。 */
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

/** Error のメッセージを表示し、それ以外の例外値には共通の開始失敗案内を使う。 */
export function resolveAuxiliaryLaunchStartErrorFeedback(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : AUXILIARY_LAUNCH_START_FAILED_FEEDBACK;
}

/** 開く時点の候補から初期選択を解決し、選択できないときだけ候補なしの案内を設定する。 */
export function resolveAuxiliaryLaunchInitialState(
  providers: readonly AuxiliaryLaunchProviderItem[],
  selectedProviderId: string | null | undefined,
): AuxiliaryLaunchInitialState {
  const providerId = resolveAuxiliaryLaunchProviderId(
    providers,
    selectedProviderId,
  );
  return {
    providerId,
    feedback: providerId ? "" : AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  };
}
