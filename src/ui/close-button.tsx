/** 閉じる対象を示す名前と、押したときに所有元で実行する処理。 */
type CloseButtonProps = {
  ariaLabel: string;
  onClose: () => void;
};

/** 閉じるアイコンの意味を指定された名前で伝え、フォームを送信せず閉じる操作を通知する。 */
export function CloseButton({ ariaLabel, onClose }: CloseButtonProps) {
  return (
    <button
      className="surface-close-button"
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClose}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}
