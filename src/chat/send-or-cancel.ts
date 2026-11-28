import type { CancelSessionRunRequest } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueOwner } from "../../src-shared/session/session-turn-queue.js";

/** 補助セッションと選択中セッションの実行情報、および操作を振り分ける先。 */
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

/** 送信ボタンが実行する送信または中止と、その宛先の組み合わせ。 */
export type AuxiliaryAwareSendOrCancelAction =
  "cancel-auxiliary" | "send-auxiliary" | "cancel-selected" | "send-selected";

/** 中止要求の宛先と、受付を追跡できる場合に付随する受付ID。 */
export type SessionStopTarget = {
  request: CancelSessionRunRequest;
  receiptId?: string;
};

/** 中止確定待ちは実行中扱いとし、それ以外は明示の実行状態を補助情報より優先する。 */
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

/** 選択中セッションまたはターンが実行中なら、操作側でも実行中として扱う。 */
export function resolveSelectedSessionIsRunning({
  runState,
  isTurnRunning = false,
}: {
  runState: string | null | undefined;
  isTurnRunning?: boolean;
}): boolean {
  return runState === "running" || isTurnRunning;
}

/** 実行中ターンを優先し、適合するターンがなければ同じセッション世代の受付を中止対象にする。 */
export function buildSessionStopTarget(
  owner: SessionTurnQueueOwner | null,
  live: { turnId?: string; receiptId?: string; incarnationId?: string },
  claim?: SessionTurnQueueOwner & { receiptId: string },
): SessionStopTarget | null {
  if (!owner) return null;
  if (
    live.turnId &&
    (!live.incarnationId || live.incarnationId === owner.incarnationId)
  ) {
    return {
      request: { ...owner, execution: { kind: "turn", id: live.turnId } },
      receiptId: live.receiptId,
    };
  }
  if (
    claim?.sessionId === owner.sessionId &&
    claim.incarnationId === owner.incarnationId
  ) {
    return {
      request: {
        ...owner,
        execution: { kind: "receipt", id: claim.receiptId },
      },
      receiptId: claim.receiptId,
    };
  }
  return null;
}

/** 補助の実行中は中止を最優先し、次に設定に従って補助への送信と選択中セッションの中止を振り分ける。 */
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

/** 現在の実行情報から送信か中止を選び、該当する宛先のコールバックだけを実行する。 */
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
