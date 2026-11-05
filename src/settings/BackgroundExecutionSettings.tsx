import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { AFFECT_COMPOSITION_INSTRUCTIONS } from "../../src-shared/character-affect/affect-composition.js";
import { MEMORY_REGISTRATION_PRESETS } from "../../src-shared/memory-recording/memory-registration-input.js";
import { BACKGROUND_PURPOSES, resolveBackgroundExecutionOptions, type BackgroundPurposeSettings } from "../../src-shared/settings/background-settings.js";
import { getApprovalOptionsForProvider, getApprovalReviewerOptionsForProvider, getDefaultApprovalModeForProvider, getSandboxOptionsForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import { DEFAULT_CODEX_REVIEWER } from "../../src-shared/settings/codex-reviewer.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import { resolveModelChangeSelection, type ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { getModelDisabledReason } from "../../src-shared/settings/model-availability.js";
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
  const enabledProviders = (catalog?.providers ?? [])
    .filter((provider) => getProviderAppSettings(settings, provider.id).enabled)
    .map((provider) => ({ ...provider, models: provider.models.filter((model) => !getModelDisabledReason(settings.modelAvailability, provider.id, model.id)) }));
  return (
    <details className="settings-section-card settings-background-section" open>
      <summary id="background-execution-heading">Background Execution</summary>
      <div className="settings-field">
        {BACKGROUND_PURPOSES.map((purpose) => {
          const current = settings.backgroundExecutionSettings[purpose];
          const provider = catalog?.providers.find((entry) => entry.id === current.selection?.providerId);
          const model = provider?.models.find((entry) => entry.id === current.selection?.modelId);
          const enabledProvider = enabledProviders.find((entry) => entry.id === current.selection?.providerId);
          const disabledModel = current.selection && getModelDisabledReason(settings.modelAvailability, current.selection.providerId, current.selection.modelId);
          const modelOptions = buildModelSelectOptions(enabledProvider?.models ?? [], current.selection?.modelId);
          const depthOptions = buildReasoningEffortSelectOptions(model?.reasoningEfforts ?? []);
          const availability = resolveBackgroundProviderAvailability(current.selection, catalog);
          const unsupportedProvider = availability.status === "unavailable" && availability.code === "BACKGROUND_PROVIDER_UNSUPPORTED";
          const disabledProvider = current.selection && !unsupportedProvider && !getProviderAppSettings(settings, current.selection.providerId).enabled;
          const canEditModel = Boolean(current.selection && enabledProvider && enabledProvider.models.length > 0);
          const preset = purpose === "affect" ? AFFECT_COMPOSITION_INSTRUCTIONS : MEMORY_REGISTRATION_PRESETS[purpose];
          const frequency = purpose === "affect" ? null : settings.memoryRecordingFrequencies[purpose];
          const approvalMode = current.selection?.approvalMode ?? getDefaultApprovalModeForProvider(current.selection?.providerId);
          const reviewer = current.selection?.codexReviewer ?? DEFAULT_CODEX_REVIEWER;
          const approvalOptions = getApprovalOptionsForProvider(current.selection?.providerId);
          const reviewerOptions = getApprovalReviewerOptionsForProvider(current.selection?.providerId, approvalMode);
          const sandboxOptions = getSandboxOptionsForProvider(current.selection?.providerId);
          let permissionError = "";
          if (current.selection) {
            try { resolveBackgroundExecutionOptions(current.selection); }
            catch (error) { permissionError = error instanceof Error ? error.message : "Invalid execution settings."; }
          }
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
                        approvalMode: getDefaultApprovalModeForProvider(nextProvider.id),
                        ...(getApprovalReviewerOptionsForProvider(nextProvider.id, getDefaultApprovalModeForProvider(nextProvider.id)).length > 0 ? { codexReviewer: DEFAULT_CODEX_REVIEWER } : {}),
                        ...(getSandboxOptionsForProvider(nextProvider.id).length > 0 ? { codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE } : {}),
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
                      const resolved = resolveModelChangeSelection(enabledProvider!, event.target.value, current.selection?.reasoningEffort ?? "");
                      onChangePurpose(purpose, { ...current, selection: {
                        ...current.selection!, providerId: provider!.id, modelId: resolved.resolvedModel,
                        reasoningEffort: resolved.resolvedReasoningEffort || undefined,
                      } });
                    }}>
                    {!current.selection ? <option value="">Not Configured</option> : null}
                    {modelOptions.map((option) => <option key={option.value} value={option.value} disabled={!option.model}>
                      {disabledModel && option.value === current.selection?.modelId ? `${model?.label ?? option.value} (Disabled)` : option.label}
                    </option>)}
                  </select>
                </label>
                {depthOptions.length > 0 && current.selection ? (
                  <label className="settings-provider-input">
                    <span>Depth</span>
                    <select aria-label={`${labels[purpose]} Depth`} value={current.selection.reasoningEffort ?? ""} disabled={!canEditModel || Boolean(disabledModel)}
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
              {current.selection ? (
                <div className="settings-background-permissions">
                  <label className="settings-provider-input">
                    <span>Approval</span>
                    <select aria-label={`${labels[purpose]} Approval`} value={approvalMode} disabled={!provider || Boolean(disabledProvider)}
                      aria-invalid={!approvalOptions.some((option) => option.value === approvalMode)}
                      onChange={(event) => onChangePurpose(purpose, { ...current, selection: { ...current.selection!, approvalMode: event.target.value as typeof approvalMode } })}>
                      {!approvalOptions.some((option) => option.value === approvalMode) ? <option value={approvalMode} disabled>{approvalMode} (Unsupported)</option> : null}
                      {approvalOptions.map((option) => <option key={option.value} value={option.value} disabled={reviewer === "auto-review" && getApprovalReviewerOptionsForProvider(current.selection!.providerId, option.value).some((entry) => entry.value === reviewer && entry.disabled)}>{option.label}</option>)}
                    </select>
                  </label>
                  {reviewerOptions.length > 0 || current.selection.codexReviewer !== undefined ? (
                    <label className="settings-provider-input">
                      <span>Reviewer</span>
                      <select aria-label={`${labels[purpose]} Reviewer`} value={current.selection.codexReviewer ?? DEFAULT_CODEX_REVIEWER}
                        disabled={!provider || Boolean(disabledProvider) || (reviewerOptions.length > 0 && approvalMode === "never")}
                        aria-invalid={reviewerOptions.length === 0 || reviewerOptions.some((option) => option.value === reviewer && option.disabled)}
                        onChange={(event) => onChangePurpose(purpose, { ...current, selection: { ...current.selection!, codexReviewer: event.target.value ? event.target.value as typeof reviewer : undefined } })}>
                        {reviewerOptions.length === 0 ? <><option value={current.selection.codexReviewer} disabled>{current.selection.codexReviewer} (Unsupported)</option><option value="">Not Applicable</option></> : reviewerOptions.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
                      </select>
                    </label>
                  ) : null}
                  {sandboxOptions.length > 0 || current.selection.codexSandboxMode !== undefined ? (
                    <label className="settings-provider-input">
                      <span>Sandbox</span>
                      <select aria-label={`${labels[purpose]} Sandbox`} value={current.selection.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE}
                        disabled={!provider || Boolean(disabledProvider)} aria-invalid={sandboxOptions.length === 0}
                        onChange={(event) => onChangePurpose(purpose, { ...current, selection: { ...current.selection!, codexSandboxMode: event.target.value ? event.target.value as typeof DEFAULT_CODEX_SANDBOX_MODE : undefined } })}>
                        {sandboxOptions.length === 0 ? <><option value={current.selection.codexSandboxMode} disabled>{current.selection.codexSandboxMode} (Unsupported)</option><option value="">Not Applicable</option></> : sandboxOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {permissionError ? <p className="settings-help settings-background-warning" role="status">{permissionError} Select a supported value or change Provider.</p> : null}
              {current.selection?.providerId === "claude" && reviewer === "auto-review" && approvalMode !== "never" ? <p className="settings-help">To use another Approval mode, select User as Reviewer first.</p> : null}
              {disabledProvider ? <p className="settings-help settings-background-warning" role="status">Unavailable. Enable {provider?.label ?? current.selection!.providerId} in Coding Agent Providers.</p>
              : disabledModel ? <p className="settings-help settings-background-warning" role="status">Unavailable. Enable the selected model and its service in Models, or select another model.</p>
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
                <button className="launch-toggle compact secondary" type="button"
                  aria-label={`${labels[purpose]} Use Preset`}
                  onClick={() => onChangePurpose(purpose, { ...current, instructionText: preset })}>
                  Use Preset
                </button>
              </div>
              <textarea
                aria-label={`${labels[purpose]} Registration Instructions`}
                value={current.instructionText ?? preset}
                rows={5}
                spellCheck={false}
                onChange={(event) => onChangePurpose(purpose, { ...current, instructionText: event.target.value })}
              />
            </div>
          );
        })}
      </div>
    </details>
  );
}
