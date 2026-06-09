import type { ProviderQuotaTelemetry } from "./app-state.js";
import type { ProviderOwnedQuotaTelemetry } from "./session-telemetry-state.js";

export type ProviderQuotaTelemetrySubscriptionApi = {
  getProviderQuotaTelemetry: (providerId: string) => Promise<ProviderQuotaTelemetry | null>;
  subscribeProviderQuotaTelemetry: (
    listener: (providerId: string, telemetry: ProviderQuotaTelemetry | null) => void,
  ) => () => void;
};

export function startProviderQuotaTelemetrySubscription(input: {
  api: ProviderQuotaTelemetrySubscriptionApi | null;
  providerId: string | null;
  enabled: boolean;
  applyProviderQuotaTelemetry: (state: ProviderOwnedQuotaTelemetry) => void;
}): () => void {
  let active = true;
  const providerId = input.providerId;

  if (!input.api || !providerId || !input.enabled) {
    input.applyProviderQuotaTelemetry({ ownerProviderId: providerId, telemetry: null });
    return () => {
      active = false;
    };
  }

  input.applyProviderQuotaTelemetry({ ownerProviderId: providerId, telemetry: null });

  void input.api.getProviderQuotaTelemetry(providerId).then((telemetry) => {
    if (active) {
      input.applyProviderQuotaTelemetry({ ownerProviderId: providerId, telemetry });
    }
  }).catch(() => {
    if (active) {
      input.applyProviderQuotaTelemetry({ ownerProviderId: providerId, telemetry: null });
    }
  });

  const unsubscribe = input.api.subscribeProviderQuotaTelemetry((nextProviderId, telemetry) => {
    if (!active || nextProviderId !== providerId) {
      return;
    }

    input.applyProviderQuotaTelemetry({ ownerProviderId: nextProviderId, telemetry });
  });

  return () => {
    active = false;
    unsubscribe();
  };
}
