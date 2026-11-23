import { getModelDisabledReason, type ModelAvailabilitySettings } from "../../src-shared/settings/model-availability.js";
import { reasoningEffortOptions } from "../../src-shared/settings/model-catalog.js";
import { isWithMateReviewProvider, type WithMateAutoReviewSettings as ReviewSelection } from "../../src-shared/settings/withmate-auto-review.js";
import type { HomeProviderSettingRow } from "./settings-view-model.js";

export function isWithMateReviewDraftIncomplete(selection: ReviewSelection | null, rows: HomeProviderSettingRow[]): boolean {
  if (!selection) return false;
  const model = rows.find(({ provider }) => provider.id === selection.providerId)?.provider.models.find(({ id }) => id === selection.model);
  return !selection.model || (!!model?.reasoningEfforts.length && !selection.reasoningEffort);
}

export function WithMateAutoReviewSettings({ selection, rows, availability, onChange }: {
  selection: ReviewSelection | null;
  rows: HomeProviderSettingRow[];
  availability: ModelAvailabilitySettings;
  onChange: (selection: ReviewSelection | null) => void;
}) {
  const providers = rows.filter(({ provider }) => isWithMateReviewProvider(provider.id));
  const provider = providers.find((row) => row.provider.id === selection?.providerId);
  const models = provider?.provider.models.filter(({ id }) => !getModelDisabledReason(availability, provider.provider.id, id)) ?? [];
  const model = models.find(({ id }) => id === selection?.model);
  const efforts = model?.reasoningEfforts ?? [];
  const unavailable = selection && (!provider?.settings.enabled || (selection.model && !model)
    || (selection.reasoningEffort && !efforts.includes(selection.reasoningEffort)));
  const incomplete = isWithMateReviewDraftIncomplete(selection, rows);

  return <details className="settings-section-card" open>
    <summary>WithMate Auto Review</summary>
    <div className="settings-field">
      <label className="settings-inline-input-row settings-review-select-row">
        <span className="settings-provider-name">Review Provider</span>
        <select value={selection?.providerId ?? ""} onChange={(event) => {
          const providerId = event.currentTarget.value;
          onChange(isWithMateReviewProvider(providerId) ? { providerId, model: "", reasoningEffort: "" } : null);
        }}>
          <option value="">Off</option>
          {providers.map(({ provider: entry, settings }) => <option key={entry.id} value={entry.id} disabled={!settings.enabled
            || !entry.models.some(({ id }) => !getModelDisabledReason(availability, entry.id, id))}>
            {entry.label}{!settings.enabled ? " (disabled)" : !entry.models.length ? " (models unavailable)" : ""}
          </option>)}
          {selection && !provider ? <option value={selection.providerId} disabled>Saved provider unavailable</option> : null}
        </select>
      </label>
      {selection ? <>
        <label className="settings-inline-input-row settings-review-select-row">
          <span className="settings-provider-name">Review Model</span>
          <select value={selection.model} disabled={!provider?.settings.enabled} onChange={(event) => {
            onChange({ ...selection, model: event.currentTarget.value, reasoningEffort: "" });
          }}>
            <option value="">Select a model</option>
            {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            {selection.model && !model ? <option value={selection.model} disabled>Saved model unavailable</option> : null}
          </select>
        </label>
        {efforts.length ? <label className="settings-inline-input-row settings-review-select-row">
          <span className="settings-provider-name">Review Depth</span>
          <select value={selection.reasoningEffort} onChange={(event) => onChange({ ...selection, reasoningEffort: event.currentTarget.value })}>
            <option value="">Select a depth</option>
            {efforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortOptions.find(({ id }) => id === effort)?.label ?? effort}</option>)}
            {selection.reasoningEffort && !efforts.includes(selection.reasoningEffort) ? <option value={selection.reasoningEffort} disabled>Saved depth unavailable</option> : null}
          </select>
        </label> : null}
      </> : null}
      {unavailable ? <p className="settings-help" role="status">This selection is unavailable. Requests remain manual. Choose an enabled reviewer or turn Auto Review off.</p>
        : incomplete ? <p className="settings-help" role="status">Choose a model and, if offered, a depth before saving.</p>
          : !providers.some((row) => row.settings.enabled) ? <p className="settings-help">Enable a supported Coding Agent Provider to set up a reviewer.</p> : null}
    </div>
  </details>;
}
