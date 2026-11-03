import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { AFFECT_COMPOSITION_INSTRUCTIONS } from "../../src-shared/character-affect/affect-composition.js";
import { MEMORY_REGISTRATION_PRESETS } from "../../src-shared/memory-recording/memory-registration-input.js";
import { BACKGROUND_PURPOSES, type BackgroundPurposeSettings } from "../../src-shared/settings/background-settings.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import { resolveModelChangeSelection, type ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { buildModelSelectOptions, buildReasoningEffortSelectOptions } from "./model-select-options.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { MemoryRecordingFrequencies } from "../../src-shared/memory-recording/memory-recording-frequency.js";

const labels: Record<BackgroundPurpose, string> = {
  "character-memory": "Character Memory",
  "target-memory": "Target Memory",
  affect: "Character Affect",
};

export type BackgroundExecutionSettingsProps = {
  settings: AppSettings;
  catalog: ModelCatalogSnapshot | null;
  onChangePurpose: (purpose: BackgroundPurpose, value: BackgroundPurposeSettings) => void;
  onChangeFrequencies: (value: MemoryRecordingFrequencies) => void;
};

export function BackgroundExecutionSettings({ settings, catalog, onChangePurpose, onChangeFrequencies }: BackgroundExecutionSettingsProps) {
  const enabledProviders = (catalog?.providers ?? []).filter((provider) => getProviderAppSettings(settings, provider.id).enabled);
  return (
    <section className="settings-section-card settings-background-section" aria-labelledby="background-execution-heading">
      <div className="settings-field">
        <strong id="background-execution-heading">Background Execution</strong>
        {BACKGROUND_PURPOSES.map((purpose) => {
          const current = settings.backgroundExecutionSettings[purpose];
          const provider = catalog?.providers.find((entry) => entry.id === current.selection?.providerId);
          const model = provider?.models.find((entry) => entry.id === current.selection?.modelId);
          const modelOptions = buildModelSelectOptions(provider?.models ?? [], current.selection?.modelId);
          const depthOptions = buildReasoningEffortSelectOptions(model?.reasoningEfforts ?? []);
          const availability = resolveBackgroundProviderAvailability(current.selection, catalog);
          const unsupportedProvider = availability.status === "unavailable" && availability.code === "BACKGROUND_PROVIDER_UNSUPPORTED";
          const disabledProvider = current.selection && !unsupportedProvider && !getProviderAppSettings(settings, current.selection.providerId).enabled;
          const canEditModel = Boolean(provider && current.selection && !disabledProvider && provider.models.length > 0);
          const preset = purpose === "affect" ? AFFECT_COMPOSITION_INSTRUCTIONS : MEMORY_REGISTRATION_PRESETS[purpose];
          const frequency = purpose === "affect" ? null : settings.memoryRecordingFrequencies[purpose];
          return (
            <div className="settings-background-purpose" key={purpose}>
              <h3>{labels[purpose]}</h3>
              <div className="settings-background-model-selection">
                <label className="settings-provider-input">
                  <span>Provider</span>
                  <select aria-label={`${labels[purpose]} Provider`} value={current.selection?.providerId ?? ""}
                    onChange={(event) => {
                      if (!event.target.value) {
                        onChangePurpose(purpose, { ...current, selection: undefined });
                        return;
                      }
                      const nextProvider = enabledProviders.find((entry) => entry.id === event.target.value)!;
                      const nextModel = nextProvider.models.find((entry) => entry.id === nextProvider.defaultModelId) ?? nextProvider.models[0];
                      const resolved = resolveModelChangeSelection(nextProvider, nextModel.id, nextProvider.defaultReasoningEffort);
                      onChangePurpose(purpose, { ...current, selection: {
                        providerId: nextProvider.id, modelId: resolved.resolvedModel,
                        reasoningEffort: resolved.resolvedReasoningEffort || undefined,
                      } });
                    }}>
                    <option value="">Not Configured</option>
                    {current.selection && !enabledProviders.some((entry) => entry.id === current.selection!.providerId)
                      ? <option value={current.selection.providerId} disabled>{provider?.label ?? current.selection.providerId} ({disabledProvider ? "Disabled" : "Unavailable"})</option> : null}
                    {enabledProviders.map((entry) => <option key={entry.id} value={entry.id} disabled={entry.models.length === 0}>
                      {entry.label}{entry.models.length === 0 ? " (Models Unavailable)" : ""}
                    </option>)}
                  </select>
                </label>
                <label className="settings-provider-input">
                  <span>Model</span>
                  <select aria-label={`${labels[purpose]} Model`} value={current.selection?.modelId ?? ""} disabled={!canEditModel}
                    onChange={(event) => {
                      const resolved = resolveModelChangeSelection(provider!, event.target.value, current.selection?.reasoningEffort ?? "");
                      onChangePurpose(purpose, { ...current, selection: {
                        providerId: provider!.id, modelId: resolved.resolvedModel,
                        reasoningEffort: resolved.resolvedReasoningEffort || undefined,
                      } });
                    }}>
                    {!current.selection ? <option value="">Not Configured</option> : null}
                    {modelOptions.map((option) => <option key={option.value} value={option.value} disabled={!option.model}>{option.label}</option>)}
                  </select>
                </label>
                {depthOptions.length > 0 && current.selection ? (
                  <label className="settings-provider-input">
                    <span>Depth</span>
                    <select aria-label={`${labels[purpose]} Depth`} value={current.selection.reasoningEffort ?? ""} disabled={!canEditModel}
                      onChange={(event) => onChangePurpose(purpose, { ...current, selection: {
                        ...current.selection!, reasoningEffort: event.target.value || undefined,
                      } })}>
                      {!depthOptions.some((option) => option.value === "") ? <option value="">Default</option> : null}
                      {current.selection.reasoningEffort && !depthOptions.some((option) => option.value === current.selection!.reasoningEffort)
                        ? <option value={current.selection.reasoningEffort}>{current.selection.reasoningEffort}</option> : null}
                      {depthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                ) : null}
              </div>
              {disabledProvider ? <p className="settings-help settings-background-warning" role="status">Unavailable. Enable {provider?.label ?? current.selection!.providerId} in Coding Agent Providers.</p>
              : availability.status === "unavailable" || availability.status === "failed" ? (
                <p className="settings-help settings-background-warning" role="status">
                  {availability.status === "failed" ? "Model Catalog Unavailable. " : "Unavailable. "}
                  {availability.reason}
                </p>
              ) : null}
              {frequency && purpose !== "affect" ? (
                <div className="settings-background-frequency">
                  {(["turnCount", "idleMinutes"] as const).map((field) => {
                    const value = frequency[field];
                    const valid = Number.isFinite(value) && value > 0 && (field !== "turnCount" || Number.isInteger(value));
                    return (
                      <label className="settings-provider-input" key={field}>
                        <span>{field === "turnCount" ? "Every Turns" : "Idle Minutes"}</span>
                        <input
                          type="number"
                          min={field === "turnCount" ? 1 : undefined}
                          step={field === "turnCount" ? 1 : "any"}
                          aria-label={`${labels[purpose]} ${field === "turnCount" ? "Every Turns" : "Idle Minutes"}`}
                          aria-invalid={!valid}
                          value={Number.isFinite(value) ? value : ""}
                          onChange={(event) => onChangeFrequencies({
                            ...settings.memoryRecordingFrequencies,
                            [purpose]: { ...frequency, [field]: event.target.value === "" ? Number.NaN : Number(event.target.value) },
                          })}
                        />
                        {!valid ? <span className="settings-background-warning">{field === "turnCount" ? "Enter a whole number of at least 1." : "Enter a number greater than 0."}</span> : null}
                      </label>
                    );
                  })}
                </div>
              ) : null}
              <div className="settings-background-instruction-head">
                <span>Registration Instructions</span>
                <label className="settings-background-preset-toggle">
                  <input
                    type="checkbox"
                    checked={current.instructionText === undefined}
                    onChange={(event) => onChangePurpose(purpose, {
                      ...current,
                      instructionText: event.target.checked ? undefined : preset,
                    })}
                  />
                  Use Preset
                </label>
              </div>
              <textarea
                aria-label={`${labels[purpose]} Registration Instructions`}
                value={current.instructionText ?? preset}
                readOnly={current.instructionText === undefined}
                rows={5}
                spellCheck={false}
                onChange={(event) => onChangePurpose(purpose, { ...current, instructionText: event.target.value })}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
