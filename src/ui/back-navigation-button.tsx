import type { ReactNode } from "react";

type BackNavigationButtonProps = {
  label: string;
  showLabel?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
  onBack: () => void;
};

export function BackNavigationButton({ label, showLabel = false, icon = "←", disabled, onBack }: BackNavigationButtonProps) {
  return (
    <button
      className="back-navigation-button"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onBack}
    >
      <span className="back-navigation-button-icon" aria-hidden="true">{icon}</span>
      {showLabel ? <span className="back-navigation-button-label">{label}</span> : null}
    </button>
  );
}
