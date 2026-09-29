export type ReadStatus = "loading" | "ready" | "error";

export function LoadingIndicator({ label, inline = false, className = "" }: {
  label: string;
  inline?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`loading-indicator${inline ? " loading-indicator-inline" : ""}${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className="loading-indicator-spinner" aria-hidden="true" />
    </span>
  );
}
