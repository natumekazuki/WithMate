import type { ProviderQuotaTelemetry, SessionContextTelemetry } from "./app-state.js";

export type ProviderOwnedQuotaTelemetry = {
  ownerProviderId: string | null;
  telemetry: ProviderQuotaTelemetry | null;
};

export type SessionOwnedContextTelemetry = {
  ownerSessionId: string | null;
  telemetry: SessionContextTelemetry | null;
};

export function resolveOwnedProviderQuotaTelemetry(
  state: ProviderOwnedQuotaTelemetry,
  providerId: string | null | undefined,
): ProviderQuotaTelemetry | null {
  return providerId && state.ownerProviderId === providerId ? state.telemetry : null;
}

export function resolveOwnedSessionContextTelemetry(
  state: SessionOwnedContextTelemetry,
  sessionId: string | null | undefined,
): SessionContextTelemetry | null {
  return sessionId !== null && sessionId !== undefined && state.ownerSessionId === sessionId
    ? state.telemetry
    : null;
}
