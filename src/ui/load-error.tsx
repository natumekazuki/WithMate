export function LoadError({ message, onRetry, retryDisabled = false, className = "", id }: {
  message: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={`load-error${className ? ` ${className}` : ""}`} role="alert">
      <p>{message}</p>
      {onRetry ? <button className="drawer-toggle compact secondary" type="button" disabled={retryDisabled} onClick={onRetry}>Retry</button> : null}
    </div>
  );
}
