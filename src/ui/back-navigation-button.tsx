import { useId, type ReactNode } from "react";

type BackNavigationButtonProps = {
  label: string;
  notice?: ReactNode;
  disabled?: boolean;
  onBack: () => void;
};

export function BackNavigationButton({ label, notice, disabled, onBack }: BackNavigationButtonProps) {
  const noticeId = useId();

  return (
    <button
      className="back-navigation-button"
      type="button"
      aria-label={label}
      aria-describedby={notice ? noticeId : undefined}
      title={label}
      disabled={disabled}
      onClick={onBack}
    >
      <span className="back-navigation-button-icon" aria-hidden="true">←</span>
      {notice ? <span id={noticeId} className="back-navigation-button-notice">{notice}</span> : null}
    </button>
  );
}
