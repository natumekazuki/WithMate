import { focusRovingItemByKey } from "../ui/a11y.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
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
  disabled?: boolean;
};

export function ProviderLaunchPicker({
  id,
  providers,
  selectedProviderId,
  onSelectProvider,
  ariaLabel = "Coding Provider",
  loadStatus = "loaded",
  loadError = "",
  disabled = false,
}: ProviderLaunchPickerProps) {
  const loading = loadStatus === "loading";
  const selectionDisabled = disabled || loadStatus !== "loaded";
  return (
    <div className="launch-provider-picker">
      <div className="launch-provider-options" data-loading={loading || undefined}>
        <div
          id={id}
          className="choice-list launch-provider-list"
          role="listbox"
          aria-label={ariaLabel}
          aria-orientation="horizontal"
          aria-disabled={selectionDisabled || undefined}
          onKeyDown={(event) => {
            if (!selectionDisabled) {
              focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
            }
          }}
        >
          {providers.map((provider) => (
            <button
              key={provider.id}
              className={`choice-chip${provider.id === selectedProviderId ? " active" : ""}`}
              type="button"
              role="option"
              aria-selected={provider.id === selectedProviderId}
              tabIndex={!selectionDisabled && provider.id === selectedProviderId ? 0 : -1}
              disabled={selectionDisabled}
              onClick={() => onSelectProvider(provider.id)}
            >
              {provider.label}
            </button>
          ))}
        </div>
        {loading ? <LoadingIndicator label="Loading coding providers" inline /> : null}
        {loadStatus === "loaded" && providers.length === 0 ? (
          <p className="launch-provider-empty">{LAUNCH_EMPTY_PROVIDER_MESSAGE}</p>
        ) : null}
      </div>
      {loadStatus === "error" ? (
        <p className="launch-provider-error" role="alert" aria-live="assertive">
          {loadError || "Could not load coding providers."}
        </p>
      ) : null}
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
  disabled,
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
          disabled={disabled}
        />
      </div>
    </section>
  );
}
