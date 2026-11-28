import { useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import { LoadError } from "../../ui/load-error.js";
import { ComposerIcon } from "../composer/composer-icon.js";
import { createSessionTurnClientRequestId } from "../runtime/session-submit-coordinator.js";
import { useFailedTurnRetry } from "../runtime/failed-turn-retry-context.js";
import type {
  useTurnInputRead,
  TurnInputReadContext,
} from "./turn-input-details.js";

/** 再送の説明に使う応答と、正確な失敗 Turn を確認するための読み取り情報。 */
type Props = {
  message: Message;
  context: TurnInputReadContext;
  read: ReturnType<typeof useTurnInputRead>;
};

/** 固定された開始入力の失敗を保存情報から確認できる場合だけ、再送を提示する。 */
export function FailedTurnRetry({ message, context, read }: Props) {
  const retry = useFailedTurnRetry();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const execution = read.observed;
  if (
    !retry ||
    read.readError ||
    execution?.turnState !== "failed" ||
    execution.receiptState !== "failed" ||
    !execution.isFixedStart ||
    !execution.turnId ||
    !execution.receiptId ||
    !execution.origin
  )
    return null;
  const { receiptId, turnId } = execution;
  /** 現在も再送可能なら元の受付と Turn を指定して一度だけ要求し、失敗を所有元か行内へ通知する。 */
  const submit = async () => {
    if (pending.current || retry.blocked(context.target.sessionId)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await retry.submit({
        target: context.target,
        receiptId,
        turnId,
        clientRequestId: createSessionTurnClientRequestId(),
      });
    } catch (failure) {
      const reason =
        failure instanceof Error
          ? failure.message
          : "Could not resend this failed Turn.";
      if (retry.onError)
        retry.onError(
          context.target.sessionId,
          reason,
          message.text.trim().slice(0, 80) || "failed response",
        );
      else setError(reason);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const name = context.target.kind === "main" ? "Main" : "Auxiliary";
  const label = `${name}: Resend Failed Turn`;
  return (
    <>
      <button
        className="message-collapse-toggle failed-turn-resend"
        type="button"
        title={label}
        aria-label={label}
        disabled={busy || retry.blocked(context.target.sessionId)}
        onClick={() => void submit()}
      >
        <ComposerIcon name="resend" />
        <span className="visually-hidden">Resend</span>
      </button>
      {error ? (
        <LoadError
          className="failed-turn-retry-feedback"
          message={`Resend: ${error}${error.includes("Check Receipt") ? "" : " Check the reason, then try Resend again."}`}
        />
      ) : null}
    </>
  );
}
