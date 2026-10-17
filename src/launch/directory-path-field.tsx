import type { RefObject } from "react";

import type { DirectoryPathValidationState } from "./directory-path-validation.js";

export function DirectoryPathField({
  id,
  label,
  ariaLabel,
  value,
  validation,
  errorMessage,
  errorRole = "status",
  checkingLabel,
  onChange,
  inputRef,
  readOnly,
  placeholder,
  autoComplete,
  spellCheck,
}: {
  id: string;
  label?: string;
  ariaLabel?: string;
  value: string;
  validation: DirectoryPathValidationState;
  errorMessage: string;
  errorRole?: "status" | "alert";
  checkingLabel: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  readOnly?: boolean;
  placeholder?: string;
  autoComplete?: string;
  spellCheck?: boolean;
}) {
  const checking = validation === "debouncing" || validation === "pending";
  const feedback = (
    <span
      id={`${id}-error`}
      className={label ? "launch-field-error" : "launch-feedback"}
      role={errorRole}
      aria-live={errorRole === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      title={label ? errorMessage || undefined : undefined}
    >
      {errorMessage}
    </span>
  );

  return (
    <div className="launch-field directory-path-field">
      {label ? (
        <div className="launch-field-heading">
          <label className="launch-field-label" htmlFor={id}>{label}</label>
          {feedback}
        </div>
      ) : null}
      <div className="launch-field-input-shell directory-path-validation-input" aria-busy={checking}>
        <input
          id={id}
          ref={inputRef}
          className="launch-field-input"
          type="text"
          aria-label={ariaLabel}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          readOnly={readOnly}
          aria-invalid={validation === "invalid" || !!errorMessage}
          aria-describedby={errorMessage ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {checking ? <span className="directory-path-validation-spinner" aria-hidden="true" /> : null}
      </div>
      {checking ? <span className="visually-hidden" role="status" aria-live="polite">{checkingLabel}</span> : null}
      {!label && errorMessage ? feedback : null}
    </div>
  );
}
