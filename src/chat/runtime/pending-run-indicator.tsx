/** 応答待ちの表示段階と、読み上げる補足文。 */
type PendingRunIndicatorProps = {
  phase: "running" | "waiting";
  announcement?: string;
};

/** 装飾のドットを読み上げ対象から外し、専用の状態領域で処理中を通知する。 */
export function PendingRunIndicator({
  phase,
  announcement,
}: PendingRunIndicatorProps) {
  const statusText = announcement?.trim() || "Running";

  return (
    <>
      <span
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
      </span>
      <div
        className="live-run-shell-status pending-run-indicator"
        data-phase={phase}
        aria-hidden="true"
      >
        <span className="typing-dots pending-run-indicator-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </>
  );
}
