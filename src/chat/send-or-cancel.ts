export type AuxiliaryAwareSendOrCancelInput = {
  shouldSendAuxiliary: boolean;
  isAuxiliarySessionRunning: boolean;
  isSelectedSessionRunning: boolean;
  preferAuxiliarySendOverSelectedCancel?: boolean;
  onCancelAuxiliaryRun: () => void | Promise<void>;
  onSendAuxiliary: () => void | Promise<void>;
  onCancelSelectedSessionRun: () => void | Promise<void>;
  onSendSelectedSession: () => void | Promise<void>;
};

export type AuxiliaryAwareSendOrCancelAction =
  | "cancel-auxiliary"
  | "send-auxiliary"
  | "cancel-selected"
  | "send-selected";

export function resolveAuxiliaryAwareSendOrCancelAction({
  shouldSendAuxiliary,
  isAuxiliarySessionRunning,
  isSelectedSessionRunning,
  preferAuxiliarySendOverSelectedCancel = false,
}: Pick<
  AuxiliaryAwareSendOrCancelInput,
  | "shouldSendAuxiliary"
  | "isAuxiliarySessionRunning"
  | "isSelectedSessionRunning"
  | "preferAuxiliarySendOverSelectedCancel"
>): AuxiliaryAwareSendOrCancelAction {
  if (isAuxiliarySessionRunning) {
    return "cancel-auxiliary";
  }

  if (preferAuxiliarySendOverSelectedCancel && shouldSendAuxiliary) {
    return "send-auxiliary";
  }

  if (isSelectedSessionRunning) {
    return "cancel-selected";
  }

  if (shouldSendAuxiliary) {
    return "send-auxiliary";
  }

  return "send-selected";
}

export function buildAuxiliaryAwareSendOrCancelHandler({
  shouldSendAuxiliary,
  isAuxiliarySessionRunning,
  isSelectedSessionRunning,
  preferAuxiliarySendOverSelectedCancel = false,
  onCancelAuxiliaryRun,
  onSendAuxiliary,
  onCancelSelectedSessionRun,
  onSendSelectedSession,
}: AuxiliaryAwareSendOrCancelInput): () => void {
  return () => {
    const action = resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary,
      isAuxiliarySessionRunning,
      isSelectedSessionRunning,
      preferAuxiliarySendOverSelectedCancel,
    });

    switch (action) {
      case "cancel-auxiliary":
        void onCancelAuxiliaryRun();
        return;
      case "send-auxiliary":
        void onSendAuxiliary();
        return;
      case "cancel-selected":
        void onCancelSelectedSessionRun();
        return;
      case "send-selected":
        void onSendSelectedSession();
        return;
    }
  };
}
