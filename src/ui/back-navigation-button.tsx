import { useId, type ReactNode } from "react";

type BackNavigationButtonProps = {
  label: string;
  notice?: ReactNode;
  onBack: () => void;
};

export function BackNavigationButton({ label, notice, onBack }: BackNavigationButtonProps) {
  const noticeId = useId();

  return (
    <button
      className="back-navigation-button"
      type="button"
      aria-label={label}
      aria-describedby={notice ? noticeId : undefined}
      title={label}
      onClick={onBack}
    >
      <span className="back-navigation-button-icon" aria-hidden="true">←</span>
      {notice ? <span id={noticeId} className="back-navigation-button-notice">{notice}</span> : null}
    </button>
  );
}
