import { focusRovingItemByKey } from "../a11y.js";

type Provider = {
  id: string;
  label: string;
};

export type ProviderLaunchPickerProps = {
  id: string;
  providers: Array<Provider>;
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string) => void;
  ariaLabel?: string;
};

const emptyProviderMessage = "有効な Coding Provider がないよ。";

export function ProviderLaunchPicker({
  id,
  providers,
  selectedProviderId,
  onSelectProvider,
  ariaLabel = "Coding Provider",
}: ProviderLaunchPickerProps) {
  if (providers.length === 0) {
    return (
      <article className="empty-list-card compact">
        <p>{emptyProviderMessage}</p>
      </article>
    );
  }

  return (
    <div
      id={id}
      className="choice-list launch-provider-list"
      role="listbox"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={(event) => {
        focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
      }}
    >
      {providers.map((provider) => (
        <button
          key={provider.id}
          className={`choice-chip${provider.id === selectedProviderId ? " active" : ""}`}
          type="button"
          role="option"
          aria-selected={provider.id === selectedProviderId}
          tabIndex={provider.id === selectedProviderId ? 0 : -1}
          onClick={() => onSelectProvider(provider.id)}
        >
          {provider.label}
        </button>
      ))}
    </div>
  );
}
