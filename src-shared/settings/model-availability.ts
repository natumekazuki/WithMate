export type ProviderModelAvailability = {
  disabledServiceIds: string[];
  disabledModelIds: string[];
};

export type ModelAvailabilitySettings = Record<string, ProviderModelAvailability>;

function normalizeDisabledIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`Model availability ${field} must be an array of non-empty IDs`);
  }
  return [...value];
}

export function normalizeModelAvailability(value: unknown): ModelAvailabilitySettings {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model availability must be a provider settings object");
  }
  return Object.fromEntries(Object.entries(value).map(([providerId, settings]) => {
    if (!providerId.trim() || !settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Model availability must contain valid provider settings");
    }
    const candidate = settings as Record<string, unknown>;
    return [providerId, {
      disabledServiceIds: normalizeDisabledIds(candidate.disabledServiceIds, "disabledServiceIds"),
      disabledModelIds: normalizeDisabledIds(candidate.disabledModelIds, "disabledModelIds"),
    }];
  }));
}

export function getModelServiceId(providerId: string, modelId: string): string | null {
  if (providerId !== "opencode") {
    return null;
  }
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(0, separator) : null;
}

export function getModelDisabledReason(
  settings: ModelAvailabilitySettings,
  providerId: string,
  modelId: string,
): "service" | "model" | null {
  const availability = Object.hasOwn(settings, providerId) ? settings[providerId] : undefined;
  if (!availability) {
    return null;
  }
  const serviceId = getModelServiceId(providerId, modelId);
  if (serviceId !== null && availability.disabledServiceIds.includes(serviceId)) {
    return "service";
  }
  return availability.disabledModelIds.includes(modelId) ? "model" : null;
}

export function assertModelEnabled(settings: ModelAvailabilitySettings, providerId: string, modelId: string): void {
  const reason = getModelDisabledReason(settings, providerId, modelId);
  if (reason !== null) {
    throw new Error(`Model ${providerId}/${modelId} is disabled by ${reason} settings`);
  }
}
