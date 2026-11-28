import type { KeyboardEventHandler, ReactNode, RefObject } from "react";
import { ButtonContent } from "../ui/button-content.js";

/** 起動ダイアログの内容とフッター、アクセス可能な名前、閉じ方を呼び出し側から受け取る。 */
type LaunchDialogShellProps = {
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  ariaLabel?: string;
  /** ダイアログ名に使う、画面上の見出しの ID。 */
  ariaLabelledBy?: string;
  showDismissControl?: boolean;
  closeOnBackdropClick?: boolean;
  className?: string;
  dialogClassName?: string;
  dialogTabIndex?: number;
  children: ReactNode;
  footer?: ReactNode;
};

/** 開始操作と任意の戻る・取消操作に加え、無効や実行中の表示を指定する。 */
export type LaunchDialogFooterProps = {
  feedback: string;
  startButtonLabel: string;
  startButtonDisabled: boolean;
  startButtonAriaDisabled?: boolean;
  startButtonBusy?: boolean;
  startButtonLoadingText?: string;
  onStart: () => void;
  startButtonRef?: RefObject<HTMLButtonElement | null>;
  backButtonLabel?: string;
  onBack?: () => void;
  backButtonDisabled?: boolean;
  cancelButtonLabel?: string;
  onCancel?: () => void;
  cancelButtonDisabled?: boolean;
  cancelButtonBusy?: boolean;
  cancelButtonLoadingText?: string;
  reserveFeedbackSpace?: boolean;
};

/** フィードバックと操作をまとめ、ラベルと実行先が揃った場合だけ戻る・取消ボタンを表示する。 */
export function LaunchDialogFooter({
  feedback,
  startButtonLabel,
  startButtonDisabled,
  startButtonAriaDisabled,
  startButtonBusy = false,
  startButtonLoadingText,
  onStart,
  startButtonRef,
  backButtonLabel,
  onBack,
  backButtonDisabled = false,
  cancelButtonLabel,
  onCancel,
  cancelButtonDisabled = false,
  cancelButtonBusy = false,
  cancelButtonLoadingText,
  reserveFeedbackSpace = false,
}: LaunchDialogFooterProps) {
  return (
    <>
      {feedback || reserveFeedbackSpace ? (
        <p
          className="launch-feedback"
          role={reserveFeedbackSpace ? "status" : undefined}
        >
          {feedback}
        </p>
      ) : null}
      {backButtonLabel && onBack ? (
        <button
          className="drawer-toggle compact secondary"
          type="button"
          disabled={backButtonDisabled}
          onClick={onBack}
        >
          {backButtonLabel}
        </button>
      ) : null}
      {cancelButtonLabel && onCancel ? (
        <button
          className="drawer-toggle compact secondary launch-cancel-button"
          type="button"
          disabled={cancelButtonDisabled || cancelButtonBusy}
          aria-busy={cancelButtonBusy || undefined}
          aria-label={
            cancelButtonBusy
              ? cancelButtonLoadingText || cancelButtonLabel
              : undefined
          }
          onClick={onCancel}
        >
          <ButtonContent busy={cancelButtonBusy}>
            {cancelButtonLabel}
          </ButtonContent>
        </button>
      ) : null}
      <button
        ref={startButtonRef}
        className="start-session-button"
        type="button"
        disabled={startButtonDisabled}
        aria-disabled={startButtonAriaDisabled}
        aria-busy={startButtonBusy || undefined}
        aria-label={
          startButtonBusy
            ? startButtonLoadingText || startButtonLabel
            : undefined
        }
        onClick={onStart}
      >
        <ButtonContent busy={startButtonBusy}>{startButtonLabel}</ButtonContent>
      </button>
    </>
  );
}

/** 共通のモーダル枠を描画し、内部クリックを背景で閉じる操作から分離する。 */
export function LaunchDialogShell({
  onClose,
  dialogRef,
  onKeyDown,
  ariaLabel,
  ariaLabelledBy,
  showDismissControl = true,
  closeOnBackdropClick = true,
  className = "launch-modal",
  dialogClassName,
  dialogTabIndex,
  children,
  footer,
}: LaunchDialogShellProps) {
  const dialogClassNameValue = [
    "launch-dialog",
    "panel",
    dialogClassName ?? "",
    showDismissControl ? "" : "launch-dialog-no-dismiss",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onClick={closeOnBackdropClick ? onClose : undefined}
    >
      <section
        ref={dialogRef}
        className={dialogClassNameValue}
        tabIndex={dialogTabIndex}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {showDismissControl ? (
          <div className="launch-dialog-head minimal">
            <button
              className="diff-close"
              type="button"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : null}

        <div className="launch-panel minimal">{children}</div>

        <div className="launch-dialog-foot minimal">{footer}</div>
      </section>
    </div>
  );
}
