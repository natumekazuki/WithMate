import { SessionRetryBanner, type SessionRetryBannerProps } from "./runtime/session-retry.js";

export type LiveSessionRetryBannerAdapterInput = SessionRetryBannerProps;

export function buildLiveSessionRetryBanner(input: LiveSessionRetryBannerAdapterInput) {
  return <SessionRetryBanner {...input} />;
}
