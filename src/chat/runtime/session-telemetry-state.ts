import type {
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../../src-shared/session/runtime-state.js";

/** 利用枠の値を、その値を取得した Provider と一緒に保持する。 */
export type ProviderOwnedQuotaTelemetry = {
  ownerProviderId: string | null;
  telemetry: ProviderQuotaTelemetry | null;
};

/** コンテキスト使用量を、その値を取得した Session と一緒に保持する。 */
export type SessionOwnedContextTelemetry = {
  ownerSessionId: string | null;
  telemetry: SessionContextTelemetry | null;
};

/** 現在の Provider が取得元と一致する場合だけ、保持済みの利用枠を使う。 */
export function resolveOwnedProviderQuotaTelemetry(
  state: ProviderOwnedQuotaTelemetry,
  providerId: string | null | undefined,
): ProviderQuotaTelemetry | null {
  return providerId && state.ownerProviderId === providerId
    ? state.telemetry
    : null;
}

/** 選択中の Session だけのコンテキスト使用量を返し、切り替え直後に以前の値を出さない。 */
export function resolveOwnedSessionContextTelemetry(
  state: SessionOwnedContextTelemetry,
  sessionId: string | null | undefined,
): SessionContextTelemetry | null {
  return sessionId !== null &&
    sessionId !== undefined &&
    state.ownerSessionId === sessionId
    ? state.telemetry
    : null;
}
