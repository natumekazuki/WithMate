import { useId, useMemo, useRef, useState } from "react";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { getModelServiceId, type ModelAvailabilitySettings } from "../../src-shared/settings/model-availability.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";
import { buildModelSelectOptions, type ModelSelectOption } from "./model-select-options.js";
import { searchModelPickerOptions } from "./model-search.js";

export type ProviderModelSettingsProps = {
  provider: ModelCatalogProvider;
  availability: ModelAvailabilitySettings;
  providerEnabled: boolean;
  discovery?: NonNullable<ModelCatalogSnapshot["discovery"]>[string];
  onChange: (next: ModelAvailabilitySettings) => void;
  onBack: () => void;
  onRetry?: () => void;
};

export function ProviderModelSettings({ provider, availability, providerEnabled, discovery, onChange, onBack, onRetry }: ProviderModelSettingsProps) {
  const [query, setQuery] = useState("");
  const [focusedModel, setFocusedModel] = useState<ModelSelectOption | null>(null);
  const [expandedServices, setExpandedServices] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedSearchServices, setCollapsedSearchServices] = useState<ReadonlySet<string>>(() => new Set());
  const [undo, setUndo] = useState<{ providerId: string; before: ModelAvailabilitySettings; after: ModelAvailabilitySettings } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const disabledReasonId = useId();
  const current = availability[provider.id] ?? { disabledServiceIds: [], disabledModelIds: [] };
  const loading = discovery?.status === "loading" || discovery?.status === "idle" && providerEnabled;
  const searching = query.trim().length > 0;
  const canUndo = undo !== null && undo.providerId === provider.id && undo.after === availability;
  const options = useMemo(() => {
    const result = buildModelSelectOptions(provider.models);
    const knownIds = new Set(result.map((option) => option.value));
    for (const id of current.disabledModelIds) {
      if (!knownIds.has(id)) {
        result.push({ value: id, label: id, model: null });
        knownIds.add(id);
      }
    }
    if (focusedModel && !knownIds.has(focusedModel.value)) result.push(focusedModel);
    return result;
  }, [provider.models, current.disabledModelIds, focusedModel]);
  const matching = useMemo(() => searchModelPickerOptions(options, query), [options, query]);
  const groups = useMemo(() => {
    const grouped = new Map<string | null, typeof matching>();
    for (const model of matching) {
      const serviceId = getModelServiceId(provider.id, model.value);
      const group = grouped.get(serviceId) ?? [];
      group.push(model);
      grouped.set(serviceId, group);
    }
    if (provider.id === "opencode") {
      const savedServices = searchModelPickerOptions(
        current.disabledServiceIds.map((id) => ({ value: id, label: id })), query,
      );
      for (const service of savedServices) {
        if (!grouped.has(service.value)) grouped.set(service.value, []);
      }
    }
    return [...grouped].sort(([a], [b]) => (a ?? "").localeCompare(b ?? "", "en", { numeric: true, sensitivity: "base" }));
  }, [matching, current.disabledServiceIds, provider.id, query]);

  const changeEnabled = (field: "disabledServiceIds" | "disabledModelIds", id: string, enabled: boolean) => {
    setUndo(null);
    onChange({
      ...availability,
      [provider.id]: {
        ...current,
        [field]: enabled ? current[field].filter((value) => value !== id) : [...current[field], id],
      },
    });
  };

  const changeModels = (models: ModelSelectOption[], serviceEnabled: boolean, enabled: boolean) => {
    if (!providerEnabled || !serviceEnabled || models.length === 0) return;
    const disabled = new Set(current.disabledModelIds);
    if (models.every((model) => disabled.has(model.value) !== enabled)) return;
    for (const model of models) {
      if (enabled) disabled.delete(model.value); else disabled.add(model.value);
    }
    const next = { ...availability, [provider.id]: { ...current, disabledModelIds: [...disabled] } };
    setUndo({ providerId: provider.id, before: availability, after: next });
    onChange(next);
    if (enabled && models.every((model) => model.model === null)) searchRef.current?.focus();
  };

  return (
    <section className="provider-model-settings" aria-labelledby={headingId}>
      <header className="provider-model-settings-head">
        <button type="button" className="drawer-toggle compact secondary" onClick={onBack}>Back</button>
        <h2 id={headingId}>{provider.label} Models</h2>
        <button type="button" className={`drawer-toggle compact secondary provider-model-undo${canUndo ? " is-available" : ""}`} disabled={!canUndo} aria-hidden={!canUndo} onClick={() => {
          if (!canUndo) return;
          onChange(undo.before);
          setUndo(null);
          searchRef.current?.focus();
        }}>Undo</button>
      </header>
      <input ref={searchRef} className="provider-model-search" type="search" aria-label="Search Models" autoFocus value={query} onChange={(event) => {
        setQuery(event.target.value);
        setCollapsedSearchServices(new Set());
      }} />
      {!providerEnabled ? <p id={disabledReasonId} className="provider-model-disabled-reason">Enable {provider.label} to use these models.</p> : null}
      <div className="provider-model-status">
        {loading ? <LoadingIndicator label={`Loading ${provider.label} Models`} inline /> : null}
        {discovery?.status === "error" ? <LoadError message={discovery.error || "Could not load models."} onRetry={onRetry} /> : null}
      </div>
      <div className="provider-model-groups" aria-label={`${provider.label} Models`}>
        {groups.map(([serviceId, models], index) => {
          const serviceEnabled = serviceId === null || !current.disabledServiceIds.includes(serviceId);
          const expanded = serviceId === null || (searching ? !collapsedSearchServices.has(serviceId) : expandedServices.has(serviceId));
          const modelsId = `${headingId}-models-${index}`;
          const countId = `${modelsId}-count`;
          return (
            <div className="provider-model-group" key={serviceId ?? ""}>
              {serviceId !== null ? <div className="provider-model-service">
                <button type="button" className="provider-model-service-disclosure" aria-label={`${serviceId} Models`} aria-describedby={countId} aria-expanded={expanded} aria-controls={modelsId} onClick={() => {
                  const update = searching ? setCollapsedSearchServices : setExpandedServices;
                  update((currentIds) => {
                    const next = new Set(currentIds);
                    if (next.has(serviceId)) next.delete(serviceId); else next.add(serviceId);
                    return next;
                  });
                }}>
                  <span className="provider-model-service-caret" aria-hidden="true">▸</span>
                  <span className="provider-model-service-name">{serviceId}</span>
                  <span id={countId} className="provider-model-service-count">{models.length.toLocaleString("en-US")} {models.length === 1 ? "Model" : "Models"}</span>
                </button>
                <label className="provider-model-service-enabled">
                  {!serviceEnabled ? <span className="provider-model-state">Service Disabled</span> : null}
                  <input type="checkbox" checked={serviceEnabled} aria-label={`${serviceId} Service`} onChange={(event) => changeEnabled("disabledServiceIds", serviceId, event.target.checked)} />
                </label>
              </div> : null}
              <div id={modelsId} hidden={!expanded} className={serviceId === null ? "provider-model-list" : "provider-model-list provider-model-list-nested"}>
                <div className="provider-model-bulk-actions" role="group" aria-label={`${serviceId ?? provider.label} Model Actions`}>
                  <button type="button" className="drawer-toggle compact secondary" disabled={!providerEnabled || !serviceEnabled || models.every((model) => !current.disabledModelIds.includes(model.value))} onClick={() => changeModels(models, serviceEnabled, true)}>Enable {searching ? "Matches" : "All"}</button>
                  <button type="button" className="drawer-toggle compact secondary" disabled={!providerEnabled || !serviceEnabled || models.every((model) => current.disabledModelIds.includes(model.value))} onClick={() => changeModels(models, serviceEnabled, false)}>Disable {searching ? "Matches" : "All"}</button>
                </div>
                {models.map((model) => <label className="provider-model-row" key={model.value} title={model.value}>
                  <input type="checkbox" checked={!current.disabledModelIds.includes(model.value)} disabled={!providerEnabled || !serviceEnabled} aria-describedby={!providerEnabled ? disabledReasonId : undefined} onFocus={() => setFocusedModel(model)} onBlur={() => setFocusedModel(null)} onChange={(event) => changeEnabled("disabledModelIds", model.value, event.target.checked)} />
                  <span className="provider-model-name">{model.label}</span>
                  {model.sourceLabel && serviceId === null ? <span className="provider-model-source">{model.sourceLabel}</span> : null}
                </label>)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
