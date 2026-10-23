import { ButtonContent } from "./button-content.js";

export function LoadError({ message, onRetry, retryDisabled = false, retryBusy = false, className = "", id }: {
  message: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  retryBusy?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={`load-error${className ? ` ${className}` : ""}`} role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button className="drawer-toggle compact secondary" type="button" disabled={retryDisabled || retryBusy} aria-busy={retryBusy || undefined} onClick={onRetry}>
          <ButtonContent busy={retryBusy} busyLabel="Retrying">Retry</ButtonContent>
        </button>
      ) : null}
    </div>
  );
}
