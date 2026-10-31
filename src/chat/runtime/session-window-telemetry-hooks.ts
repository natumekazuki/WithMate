import { useEffect, useMemo, useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  resolveOwnedProviderQuotaTelemetry,
  resolveOwnedSessionContextTelemetry,
  type ProviderOwnedQuotaTelemetry,
  type SessionOwnedContextTelemetry,
} from "./session-telemetry-state.js";
import {
  startProviderQuotaTelemetrySubscription,
  startSessionContextTelemetrySubscription,
} from "./session-telemetry-subscription.js";

export function useSessionTelemetry(
  api: WithMateWindowApi | null,
  providerId: string | null | undefined,
  sessionId: string | null,
): {
  providerQuotaTelemetryState: ProviderOwnedQuotaTelemetry;
  sessionContextTelemetryState: SessionOwnedContextTelemetry;
  selectedProviderQuotaTelemetry: ReturnType<typeof resolveOwnedProviderQuotaTelemetry>;
  selectedSessionContextTelemetry: ReturnType<typeof resolveOwnedSessionContextTelemetry>;
} {
  const [providerQuotaTelemetryState, setProviderQuotaTelemetryState] = useState<ProviderOwnedQuotaTelemetry>({
    ownerProviderId: null,
    telemetry: null,
  });
  const [sessionContextTelemetryState, setSessionContextTelemetryState] = useState<SessionOwnedContextTelemetry>({
    ownerSessionId: null,
    telemetry: null,
  });
  const isCopilot = providerId === "copilot";

  useEffect(() => startProviderQuotaTelemetrySubscription({
    api,
    providerId: providerId ?? null,
    enabled: isCopilot,
    applyProviderQuotaTelemetry: setProviderQuotaTelemetryState,
  }), [api, isCopilot, providerId]);

  useEffect(() => startSessionContextTelemetrySubscription({
    api,
    sessionId,
    enabled: isCopilot,
    applySessionContextTelemetry: setSessionContextTelemetryState,
  }), [api, isCopilot, sessionId]);

  const selectedProviderQuotaTelemetry = useMemo(
    () => resolveOwnedProviderQuotaTelemetry(providerQuotaTelemetryState, providerId),
    [providerId, providerQuotaTelemetryState.ownerProviderId, providerQuotaTelemetryState.telemetry],
  );
  const selectedSessionContextTelemetry = useMemo(
    () => resolveOwnedSessionContextTelemetry(sessionContextTelemetryState, sessionId),
    [sessionId, sessionContextTelemetryState.ownerSessionId, sessionContextTelemetryState.telemetry],
  );

  return {
    providerQuotaTelemetryState,
    sessionContextTelemetryState,
    selectedProviderQuotaTelemetry,
    selectedSessionContextTelemetry,
  };
}
