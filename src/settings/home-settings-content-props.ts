import type { HomeSettingsContentProps } from "./SettingsContent.js";

export type HomeSettingsContentBaseProps = Omit<
  HomeSettingsContentProps,
  | "memoryManagementOnly"
  | "onApplyPendingGrowth"
  | "applyPendingGrowthBusy"
  | "canApplyPendingGrowth"
  | "onResetMate"
  | "mateResetBusy"
  | "canResetMate"
>;

export const buildHomeSettingsContentProps = (
  input: HomeSettingsContentBaseProps & {
    onApplyPendingGrowth: () => void;
    applyPendingGrowthBusy: boolean;
    canApplyPendingGrowth: boolean;
    onResetMate: () => void;
    mateResetBusy: boolean;
    canResetMate: boolean;
  },
): HomeSettingsContentProps => ({
  ...input,
});

export const buildHomeMemoryManagementContentProps = (
  baseProps: HomeSettingsContentBaseProps,
): HomeSettingsContentProps => ({
  ...baseProps,
  memoryManagementOnly: true,
});
