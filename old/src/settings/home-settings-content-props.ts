import type { HomeSettingsContentProps } from "./SettingsContent.js";

export type HomeSettingsContentBaseProps = HomeSettingsContentProps;

export const buildHomeSettingsContentProps = (
  input: HomeSettingsContentBaseProps,
): HomeSettingsContentProps => ({
  ...input,
});
