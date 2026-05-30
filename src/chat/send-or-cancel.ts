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
    if (isAuxiliarySessionRunning) {
      void onCancelAuxiliaryRun();
      return;
    }

    if (preferAuxiliarySendOverSelectedCancel && shouldSendAuxiliary) {
      void onSendAuxiliary();
      return;
    }

    if (isSelectedSessionRunning) {
      void onCancelSelectedSessionRun();
      return;
    }

    if (shouldSendAuxiliary) {
      void onSendAuxiliary();
      return;
    }

    void onSendSelectedSession();
  };
}
