import type { HomeSettingsContentProps } from "./SettingsContent.js";

export type HomeSettingsContentBaseProps = Omit<
  HomeSettingsContentProps,
  | "onResetMate"
  | "mateResetBusy"
  | "canResetMate"
>;

export const buildHomeSettingsContentProps = (
  input: HomeSettingsContentBaseProps & {
    onResetMate: () => void;
    mateResetBusy: boolean;
    canResetMate: boolean;
  },
): HomeSettingsContentProps => ({
  ...input,
});
