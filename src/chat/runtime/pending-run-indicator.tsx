type PendingRunIndicatorProps = {
  announcement?: string;
  text?: string;
  showText?: boolean;
  className?: string;
  announce?: boolean;
};

export function PendingRunIndicator({
  announcement,
  text = "Running",
  showText = true,
  className = "",
  announce = true,
}: PendingRunIndicatorProps) {
  const indicatorText = text.trim() || "Running";
  const statusText = announcement?.trim() || indicatorText;

  return (
    <>
      {announce ? (
        <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {statusText}
        </span>
      ) : null}
      <div className={`live-run-shell-status pending-run-indicator${className ? ` ${className}` : ""}`} aria-hidden="true">
        {showText ? <span className="live-run-shell-status-text">{indicatorText}</span> : null}
        <span className="typing-dots pending-run-indicator-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </>
  );
}
