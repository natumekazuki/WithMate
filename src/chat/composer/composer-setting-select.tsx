import type { RefObject } from "react";

/** コンポーザーの設定値を選択欄として表示し、候補外の現在値もツールチップで確認できるようにする。 */
export function ComposerSettingSelect({
  className,
  label,
  value,
  options,
  onChange,
  disabled,
  invalid,
  selectRef,
}: {
  className?: string;
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  selectRef?: RefObject<HTMLSelectElement | null>;
}) {
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? value;
  return (
    <label
      className={`composer-setting-field${className ? ` ${className}` : ""}`}
    >
      <select
        ref={selectRef}
        aria-label={label}
        title={`${label}: ${selectedLabel}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={invalid || undefined}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
