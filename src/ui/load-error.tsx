import { ButtonContent } from "./button-content.js";

/** 読み取り失敗を通知し、再試行の実行先がある場合だけ処理状態付きのボタンを添える。 */
export function LoadError({
  message,
  onRetry,
  retryDisabled = false,
  retryBusy = false,
  className = "",
  id,
}: {
  message: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  retryBusy?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`load-error${className ? ` ${className}` : ""}`}
      role="alert"
    >
      <p>{message}</p>
      {onRetry ? (
        <button
          className="drawer-toggle compact secondary"
          type="button"
          disabled={retryDisabled || retryBusy}
          aria-busy={retryBusy || undefined}
          onClick={onRetry}
        >
          <ButtonContent busy={retryBusy} busyLabel="Retrying">
            Retry
          </ButtonContent>
        </button>
      ) : null}
    </div>
  );
}
