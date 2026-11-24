import type { CancelSessionRunRequest } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueOwner } from "../../src-shared/session/session-turn-queue.js";

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

export type SessionStopTarget = { request: CancelSessionRunRequest; receiptId?: string };

export function resolveSelectedSessionRunState<TRunState extends string>({
  runState,
  isTurnRunning = false,
  hasLiveRun = false,
  isCancellationPending = false,
}: {
  runState: TRunState | null | undefined;
  isTurnRunning?: boolean;
  hasLiveRun?: boolean;
  isCancellationPending?: boolean;
}): TRunState | "running" | null {
  if (isCancellationPending) return "running";
  return runState ?? (isTurnRunning || hasLiveRun ? "running" : null);
}

export function resolveSelectedSessionIsRunning({
  runState,
  isTurnRunning = false,
}: {
  runState: string | null | undefined;
  isTurnRunning?: boolean;
}): boolean {
  return runState === "running" || isTurnRunning;
}

export function buildSessionStopTarget(
  owner: SessionTurnQueueOwner | null,
  live: { turnId?: string; receiptId?: string; incarnationId?: string },
  claim?: SessionTurnQueueOwner & { receiptId: string },
): SessionStopTarget | null {
  if (!owner) return null;
  if (live.turnId && (!live.incarnationId || live.incarnationId === owner.incarnationId)) {
    return { request: { ...owner, execution: { kind: "turn", id: live.turnId } }, receiptId: live.receiptId };
  }
  if (claim?.sessionId === owner.sessionId && claim.incarnationId === owner.incarnationId) {
    return { request: { ...owner, execution: { kind: "receipt", id: claim.receiptId } }, receiptId: claim.receiptId };
  }
  return null;
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
