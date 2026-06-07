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

export type RunningSessionCancelTarget = {
  id: string;
  runState: string | null | undefined;
  isRunning?: boolean;
} | null | undefined;

export function buildRunningSessionCancelTarget({
  sessionId,
  runState,
  isRunning,
}: {
  sessionId: string | null | undefined;
  runState: string | null | undefined;
  isRunning: boolean;
}): RunningSessionCancelTarget {
  return sessionId
    ? { id: sessionId, runState, isRunning }
    : null;
}

export function resolveRunningSessionCancelTargetId(
  target: RunningSessionCancelTarget,
): string | null {
  return target && (target.isRunning || target.runState === "running") ? target.id : null;
}

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
