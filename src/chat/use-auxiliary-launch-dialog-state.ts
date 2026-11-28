import { useState } from "react";

import {
  type AuxiliaryLaunchProviderItem,
  applyAuxiliaryLaunchDialogState,
  resolveAuxiliaryLaunchCloseState,
  resolveAuxiliaryLaunchFeedbackResetState,
  resolveAuxiliaryLaunchOpenState,
  resolveAuxiliaryLaunchProviderSelectionState,
  resolveAuxiliaryLaunchStartErrorState,
} from "./auxiliary-launch-state.js";

/** 開く時点で使える Provider 候補と、優先したい選択肢。 */
type OpenAuxiliaryLaunchDialogParams = {
  providers: readonly AuxiliaryLaunchProviderItem[];
  selectedProviderId: string | null | undefined;
};

/** Auxiliary 起動欄の開閉、Provider 選択、起動時のフィードバックを管理する。 */
export function useAuxiliaryLaunchDialogState() {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  /** 開く時点の候補から選択と初期フィードバックを決める。 */
  const openDialog = ({
    providers,
    selectedProviderId,
  }: OpenAuxiliaryLaunchDialogParams) => {
    const state = resolveAuxiliaryLaunchOpenState(
      providers,
      selectedProviderId,
    );
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, state);
  };

  /** 起動欄を閉じて通知を消し、作成リクエストの取消は行わない。 */
  const closeDialog = () => {
    applyAuxiliaryLaunchDialogState(
      setOpen,
      setProviderId,
      setFeedback,
      resolveAuxiliaryLaunchCloseState(),
    );
  };

  /** 指定された候補へ切り替え、以前の選択に対する通知を消す。 */
  const selectProvider = (nextProviderId: string) => {
    const state = resolveAuxiliaryLaunchProviderSelectionState(nextProviderId);
    applyAuxiliaryLaunchDialogState(setOpen, setProviderId, setFeedback, state);
  };

  /** 起動欄の開閉と選択は変えず、通知だけを消す。 */
  const resetFeedback = () => {
    applyAuxiliaryLaunchDialogState(
      setOpen,
      setProviderId,
      setFeedback,
      resolveAuxiliaryLaunchFeedbackResetState(),
    );
  };

  /** 起動の失敗理由を表示用に変換し、現在の選択と開閉状態は保持する。 */
  const setStartError = (error: unknown) => {
    applyAuxiliaryLaunchDialogState(
      setOpen,
      setProviderId,
      setFeedback,
      resolveAuxiliaryLaunchStartErrorState(error),
    );
  };

  return {
    auxiliaryLaunchDialogOpen: open,
    auxiliaryLaunchProviderId: providerId,
    auxiliaryLaunchFeedback: feedback,
    openAuxiliaryLaunchDialog: openDialog,
    closeAuxiliaryLaunchDialog: closeDialog,
    selectAuxiliaryLaunchProvider: selectProvider,
    resetAuxiliaryLaunchFeedback: resetFeedback,
    setAuxiliaryLaunchStartError: setStartError,
  } as const;
}
