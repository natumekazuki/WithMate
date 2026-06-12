import { SessionRetryBanner, type SessionRetryBannerProps } from "../session-components.js";

export type LiveSessionRetryBannerAdapterInput = SessionRetryBannerProps;

export function buildLiveSessionRetryBanner(input: LiveSessionRetryBannerAdapterInput) {
  return <SessionRetryBanner {...input} />;
}
