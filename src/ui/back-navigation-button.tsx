import type { ReactNode } from "react";

/** 戻る先を示すラベルと、任意のアイコン・文言表示・無効状態を受け取る。 */
type BackNavigationButtonProps = {
  label: string;
  showLabel?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
  onBack: () => void;
};

/** アイコンだけで表示する場合も、戻る操作の名前をボタンとツールチップに付ける。 */
export function BackNavigationButton({
  label,
  showLabel = false,
  icon = "←",
  disabled,
  onBack,
}: BackNavigationButtonProps) {
  return (
    <button
      className="back-navigation-button"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onBack}
    >
      <span className="back-navigation-button-icon" aria-hidden="true">
        {icon}
      </span>
      {showLabel ? (
        <span className="back-navigation-button-label">{label}</span>
      ) : null}
    </button>
  );
}
