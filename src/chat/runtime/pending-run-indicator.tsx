type PendingRunIndicatorProps = {
  announcement?: string;
  text?: string;
  className?: string;
};

export function PendingRunIndicator({
  announcement,
  text = "処理を実行中",
  className = "",
}: PendingRunIndicatorProps) {
  const indicatorText = text.trim() || "処理を実行中";
  const statusText = announcement?.trim() || indicatorText;

  return (
    <>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      <div className={`live-run-shell-status pending-run-indicator${className ? ` ${className}` : ""}`} aria-hidden="true">
        <span className="live-run-shell-status-badge">実行中</span>
        <span className="live-run-shell-status-text">{indicatorText}</span>
        <span className="typing-dots pending-run-indicator-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </>
  );
}
