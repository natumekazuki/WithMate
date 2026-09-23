import { focusRovingItemByKey } from "../ui/a11y.js";
import { LAUNCH_EMPTY_PROVIDER_MESSAGE } from "./launch-feedback.js";

type Provider = {
  id: string;
  label: string;
};

export type ProviderLaunchLoadStatus = "loading" | "loaded" | "error";

export type ProviderLaunchPickerProps = {
  id: string;
  providers: Array<Provider>;
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string) => void;
  ariaLabel?: string;
  loadStatus?: ProviderLaunchLoadStatus;
  loadError?: string;
};

export function ProviderLaunchPicker({
  id,
  providers,
  selectedProviderId,
  onSelectProvider,
  ariaLabel = "Coding Provider",
  loadStatus = "loaded",
  loadError = "",
}: ProviderLaunchPickerProps) {
  if (loadStatus === "loading") {
    return (
      <div
        id={id}
        className="chat-skill-picker-state"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="chat-skill-picker-spinner" aria-hidden="true" />
        <span className="visually-hidden">Loading coding providers.</span>
      </div>
    );
  }

  if (loadStatus === "error") {
    return (
      <p id={id} className="chat-skill-picker-state error" role="alert" aria-live="assertive">
        {loadError || "Could not load coding providers."}
      </p>
    );
  }

  if (providers.length === 0) {
    return (
      <article className="empty-list-card compact">
        <p>{LAUNCH_EMPTY_PROVIDER_MESSAGE}</p>
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

export type ProviderLaunchFieldProps = Omit<ProviderLaunchPickerProps, "id"> & {
  fieldId: string;
};

export function ProviderLaunchField({
  fieldId,
  providers,
  selectedProviderId,
  onSelectProvider,
  ariaLabel,
  loadStatus,
  loadError,
}: ProviderLaunchFieldProps) {
  return (
    <section className="launch-section minimal">
      <div className="launch-field">
        <label className="launch-field-label" htmlFor={fieldId}>
          Coding Provider
        </label>
        <ProviderLaunchPicker
          id={fieldId}
          providers={providers}
          selectedProviderId={selectedProviderId}
          onSelectProvider={onSelectProvider}
          ariaLabel={ariaLabel}
          loadStatus={loadStatus}
          loadError={loadError}
        />
      </div>
    </section>
  );
}
