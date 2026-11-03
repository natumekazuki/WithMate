import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { AFFECT_COMPOSITION_INSTRUCTIONS } from "../../src-shared/character-affect/affect-composition.js";
import { MEMORY_REGISTRATION_PRESETS } from "../../src-shared/memory-recording/memory-registration-input.js";
import { BACKGROUND_PURPOSES, type BackgroundPurposeSettings } from "../../src-shared/settings/background-settings.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
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
  const options = (catalog?.providers ?? []).flatMap((provider) => provider.models.map((model) => ({
    value: JSON.stringify({ providerId: provider.id, modelId: model.id }),
    label: `${provider.label} / ${model.label}${model.label !== model.id ? ` (${model.id})` : ""}`,
  })));
  return (
    <section className="settings-section-card settings-background-section" aria-labelledby="background-execution-heading">
      <div className="settings-field">
        <strong id="background-execution-heading">Background Execution</strong>
        {BACKGROUND_PURPOSES.map((purpose) => {
          const current = settings.backgroundExecutionSettings[purpose];
          const selectedValue = current.selection ? JSON.stringify(current.selection) : "";
          const availability = resolveBackgroundProviderAvailability(current.selection, catalog);
          const disabledProvider = availability.status === "available" && !settings.codingProviderSettings[availability.providerId]?.enabled;
          const preset = purpose === "affect" ? AFFECT_COMPOSITION_INSTRUCTIONS : MEMORY_REGISTRATION_PRESETS[purpose];
          const frequency = purpose === "affect" ? null : settings.memoryRecordingFrequencies[purpose];
          return (
            <div className="settings-background-purpose" key={purpose}>
              <h3>{labels[purpose]}</h3>
              <label className="settings-provider-input">
                <span>Provider / Model</span>
                <select
                  aria-label={`${labels[purpose]} Provider / Model`}
                  value={selectedValue}
                  onChange={(event) => onChangePurpose(purpose, {
                    ...current,
                    selection: event.target.value ? JSON.parse(event.target.value) : undefined,
                  })}
                >
                  <option value="">Not Configured</option>
                  {selectedValue && !options.some((option) => option.value === selectedValue)
                    ? <option value={selectedValue}>{current.selection!.providerId} / {current.selection!.modelId}</option>
                    : null}
                  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              {disabledProvider ? <p className="settings-help settings-background-warning" role="status">Unavailable. Enable Claude in Coding Agent Providers.</p>
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
