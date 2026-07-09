import type { ProviderQuotaTelemetry, SessionContextTelemetry } from "./app-state.js";
import type { ProviderOwnedQuotaTelemetry, SessionOwnedContextTelemetry } from "./session-telemetry-state.js";

export type ProviderQuotaTelemetrySubscriptionApi = {
  getProviderQuotaTelemetry: (providerId: string) => Promise<ProviderQuotaTelemetry | null>;
  subscribeProviderQuotaTelemetry: (
    listener: (providerId: string, telemetry: ProviderQuotaTelemetry | null) => void,
  ) => () => void;
};

export type SessionContextTelemetrySubscriptionApi = {
  getSessionContextTelemetry: (sessionId: string) => Promise<SessionContextTelemetry | null>;
  subscribeSessionContextTelemetry: (
    listener: (sessionId: string, telemetry: SessionContextTelemetry | null) => void,
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
  let receivedSubscriptionUpdate = false;

  void input.api.getProviderQuotaTelemetry(providerId).then((telemetry) => {
    if (active && !receivedSubscriptionUpdate) {
      input.applyProviderQuotaTelemetry({ ownerProviderId: providerId, telemetry });
    }
  }).catch(() => {
    if (active && !receivedSubscriptionUpdate) {
      input.applyProviderQuotaTelemetry({ ownerProviderId: providerId, telemetry: null });
    }
  });

  const unsubscribe = input.api.subscribeProviderQuotaTelemetry((nextProviderId, telemetry) => {
    if (!active || nextProviderId !== providerId) {
      return;
    }

    receivedSubscriptionUpdate = true;
    input.applyProviderQuotaTelemetry({ ownerProviderId: nextProviderId, telemetry });
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

export function startSessionContextTelemetrySubscription(input: {
  api: SessionContextTelemetrySubscriptionApi | null;
  sessionId: string | null;
  enabled: boolean;
  applySessionContextTelemetry: (state: SessionOwnedContextTelemetry) => void;
}): () => void {
  let active = true;
  const sessionId = input.sessionId;

  if (!input.api || !sessionId || !input.enabled) {
    input.applySessionContextTelemetry({ ownerSessionId: sessionId, telemetry: null });
    return () => {
      active = false;
    };
  }

  input.applySessionContextTelemetry({ ownerSessionId: sessionId, telemetry: null });
  let receivedSubscriptionUpdate = false;

  void input.api.getSessionContextTelemetry(sessionId).then((telemetry) => {
    if (active && !receivedSubscriptionUpdate) {
      input.applySessionContextTelemetry({ ownerSessionId: sessionId, telemetry });
    }
  }).catch(() => {
    if (active && !receivedSubscriptionUpdate) {
      input.applySessionContextTelemetry({ ownerSessionId: sessionId, telemetry: null });
    }
  });

  const unsubscribe = input.api.subscribeSessionContextTelemetry((nextSessionId, telemetry) => {
    if (!active || nextSessionId !== sessionId) {
      return;
    }

    receivedSubscriptionUpdate = true;
    input.applySessionContextTelemetry({ ownerSessionId: nextSessionId, telemetry });
  });

  return () => {
    active = false;
    unsubscribe();
  };
}
