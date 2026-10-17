export function ComposerSettingSelect({ className, label, value, options, onChange, disabled, invalid }: {
  className?: string;
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  return (
    <label className={`composer-setting-field${className ? ` ${className}` : ""}`}>
      <select
        aria-label={label}
        title={`${label}: ${selectedLabel}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={invalid || undefined}
      >
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    </label>
  );
}
