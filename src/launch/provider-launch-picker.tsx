import { focusRovingItemByKey } from "../ui/a11y.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ErrorDetailsButton } from "../ui/error-details.js";
import { LAUNCH_EMPTY_PROVIDER_MESSAGE } from "./launch-feedback.js";

/** 起動時の選択肢を識別する Provider ID と画面上の表示名。 */
type Provider = {
  id: string;
  label: string;
};

/** 候補の取得中・取得済み・取得失敗を区別し、取得済みの空一覧と失敗を混同しない。 */
export type ProviderLaunchLoadStatus = "loading" | "loaded" | "error";

/** 候補と選択を外から管理し、必要なら取得失敗時の再試行も提供する。 */
export type ProviderLaunchPickerProps = {
  id: string;
  providers: Array<Provider>;
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string) => void;
  ariaLabel?: string;
  loadStatus?: ProviderLaunchLoadStatus;
  loadError?: string;
  onRetryLoad?: () => void;
  disabled?: boolean;
};

/** Provider の横方向の選択肢を表示し、取得済みで操作可能なときだけ選択を受け付ける。 */
export function ProviderLaunchPicker({
  id,
  providers,
  selectedProviderId,
  onSelectProvider,
  ariaLabel = "Coding Provider",
  loadStatus = "loaded",
  loadError = "",
  onRetryLoad,
  disabled = false,
}: ProviderLaunchPickerProps) {
  const loading = loadStatus === "loading";
  const selectionDisabled = disabled || loadStatus !== "loaded";
  return (
    <div className="launch-provider-picker">
      <div
        className="launch-provider-options"
        data-loading={loading || undefined}
      >
        <div
          id={id}
          className="choice-list launch-provider-list"
          role="listbox"
          aria-label={ariaLabel}
          aria-orientation="horizontal"
          aria-disabled={selectionDisabled || undefined}
          onKeyDown={(event) => {
            if (!selectionDisabled) {
              focusRovingItemByKey(event, {
                orientation: "horizontal",
                activateOnFocus: true,
              });
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
              tabIndex={
                !selectionDisabled && provider.id === selectedProviderId
                  ? 0
                  : -1
              }
              disabled={selectionDisabled}
              onClick={() => onSelectProvider(provider.id)}
            >
              {provider.label}
            </button>
          ))}
        </div>
        {loading ? (
          <LoadingIndicator label="Loading coding providers" inline />
        ) : null}
        {loadStatus === "loaded" && providers.length === 0 ? (
          <p className="launch-provider-empty">
            {LAUNCH_EMPTY_PROVIDER_MESSAGE}
          </p>
        ) : null}
        {loadStatus === "error" && onRetryLoad ? (
          <div className="launch-provider-error">
            <span className="visually-hidden" role="alert">
              Could not load coding providers.
            </span>
            <ErrorDetailsButton
              message={loadError || "Could not load coding providers."}
              label="Provider Load Error Details"
            />
            <button
              className="drawer-toggle compact secondary"
              type="button"
              disabled={disabled}
              onClick={onRetryLoad}
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
      {loadStatus === "error" && !onRetryLoad ? (
        <p className="launch-provider-error" role="alert" aria-live="assertive">
          {loadError || "Could not load coding providers."}
        </p>
      ) : null}
    </div>
  );
}

/** 共通の Provider 選択欄の入力に、見出しと関連付けるフィールド識別子を加える。 */
export type ProviderLaunchFieldProps = Omit<ProviderLaunchPickerProps, "id"> & {
  fieldId: string;
};

/** 起動フォームの見出しと Provider 選択 UI を同じフィールドとして配置する。 */
export function ProviderLaunchField({
  fieldId,
  providers,
  selectedProviderId,
  onSelectProvider,
  ariaLabel,
  loadStatus,
  loadError,
  onRetryLoad,
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
          onRetryLoad={onRetryLoad}
          disabled={disabled}
        />
      </div>
    </section>
  );
}
