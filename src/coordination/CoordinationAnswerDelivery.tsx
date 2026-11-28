import { useEffect, useState } from "react";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { LoadError } from "../ui/load-error.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";

/** 受付 ID と宛先を指定して読み出した、実行情報の成功結果。 */
type Execution = Extract<
  SessionExecutionReadResult<"get_execution">,
  { ok: true }
>;

/** 受付状態を短い表示名に変換し、中断による結果不明と未認識の値を区別する。 */
export function receiptStateLabel(state: string | null) {
  return (
    {
      queued: "Queued",
      starting: "Starting",
      running: "In Progress",
      completed: "Completed",
      failed: "Failed",
      canceled: "Canceled",
      interrupted: "Outcome Unknown",
    }[state ?? ""] ?? "Unknown"
  );
}

/** 回答の保存・配送・相手による取得と使用を区別し、相手の Turn の状態は別に示す。 */
export function CoordinationAnswerDelivery({
  ownerSessionId,
  target,
  receiptId,
  acquired,
  consumed,
  active = true,
  onDeliveryChange,
}: {
  ownerSessionId: string;
  target?: SessionTarget;
  receiptId?: string;
  acquired?: boolean;
  consumed?: boolean;
  active?: boolean;
  onDeliveryChange?: () => void;
}) {
  const [state, setState] = useState<{
    key: string;
    result: Execution | null;
    error: string;
    loading: boolean;
  }>({ key: "", result: null, error: "", loading: false });
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([ownerSessionId, target, receiptId]);
  const result = state.key === identity ? state.result : null;
  const error = state.key === identity ? state.error : "";
  const loading = state.key === identity && state.loading;

  useEffect(() => {
    if (!active || !receiptId) return;
    let current = true;
    setState((previous) => ({
      key: identity,
      result: previous.key === identity ? previous.result : null,
      error: "",
      loading: true,
    }));
    /** 正確な宛先と受付を指定して実行情報を読み、現在の購読世代にだけ反映する。 */
    const read = async () => {
      const api = getWithMateApi();
      if (!target)
        throw new Error("The exact recipient reference is unavailable.");
      if (!api?.readSessionExecution)
        throw new Error("Saved execution reads are unavailable.");
      const next = await api.readSessionExecution(
        ownerSessionId,
        "get_execution",
        { target, receiptId },
      );
      if (!current) return;
      if (!next.ok) throw new Error(next.message);
      setState({ key: identity, result: next, error: "", loading: false });
    };
    void read().catch((reason: unknown) => {
      if (current)
        setState((previous) => ({
          ...previous,
          key: identity,
          loading: false,
          error:
            reason instanceof Error
              ? reason.message
              : "Delivery could not be confirmed.",
        }));
    });
    return () => {
      current = false;
    };
  }, [identity, active, revision]);
  useEffect(() => {
    if (!active || !target || !receiptId) return;
    /** 宛先 Session に変化があったときだけ受付を再読し、所有元にも更新を通知する。 */
    const refresh = (sessionId: string) => {
      if (sessionId === target.sessionId) {
        setRevision((value) => value + 1);
        onDeliveryChange?.();
      }
    };
    const api = getWithMateApi();
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => {
      queueChanged?.();
      turnUpdated?.();
    };
  }, [identity, active, onDeliveryChange]);

  if (!receiptId)
    return (
      <p className="coordination-parties" role="status">
        {acquired ? "Received" : "Saved · Not Sent"}
        {consumed ? " · Answer Used" : ""}
      </p>
    );
  const turnFailure =
    result && ["failed", "canceled"].includes(result.turnState ?? "")
      ? ` · Turn ${receiptStateLabel(result.turnState)}`
      : "";
  const entry = result?.inputs?.entry;
  // 開始の受付情報には、その Turn の終了状態が反映される。追加入力には独立した配送結果がある。
  const sameFailedTurn =
    result?.turnState === "failed" &&
    (result.receiptState === "failed" ||
      result.receiptState === "interrupted") &&
    entry?.kind === "start" &&
    entry.inputSeq !== null &&
    entry.inputSeq === result.userMessageSeq;
  const deliveryLabel = acquired
    ? `Received${turnFailure}`
    : error
      ? "Delivery Unknown"
      : result
        ? sameFailedTurn
          ? "Turn Failed"
          : `${result.receiptState === "completed" ? "Delivered" : `Delivery ${receiptStateLabel(result.receiptState)}`}${turnFailure}`
        : null;
  return (
    <div
      className="coordination-answer-delivery"
      aria-busy={loading || undefined}
    >
      {active && deliveryLabel === null ? (
        <LoadingIndicator
          label="Checking Answer Delivery"
          inline
          className="coordination-inline-loading"
        />
      ) : null}
      {deliveryLabel !== null || consumed ? (
        <p className="coordination-parties" role="status">
          {deliveryLabel}
          {consumed ? " · Answer Used" : ""}
        </p>
      ) : null}
      {error ? (
        <LoadError
          message={error}
          onRetry={() => setRevision((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}
