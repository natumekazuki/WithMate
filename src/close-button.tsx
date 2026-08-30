type CloseButtonProps = {
  ariaLabel: string;
  onClose: () => void;
};

export function CloseButton({ ariaLabel, onClose }: CloseButtonProps) {
  return (
    <button className="surface-close-button" type="button" aria-label={ariaLabel} onClick={onClose}>
      ×
    </button>
  );
}
