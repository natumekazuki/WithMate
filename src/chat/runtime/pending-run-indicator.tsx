type PendingRunIndicatorProps = {
  announcement?: string;
};

export function PendingRunIndicator({ announcement }: PendingRunIndicatorProps) {
  const statusText = announcement?.trim() || "Running";

  return (
    <>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      <div className="live-run-shell-status pending-run-indicator" aria-hidden="true">
        <span className="typing-dots pending-run-indicator-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </>
  );
}
