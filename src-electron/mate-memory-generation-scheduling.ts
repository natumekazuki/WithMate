import type { MateGrowthSettings, MateStorageState } from "../src/mate/mate-state.js";
import type { AppSettings } from "../src/provider-settings-state.js";

export const SUPPORTED_MATE_MEMORY_CANDIDATE_AUTO_MODES = ["every_turn"] as const;

export function shouldScheduleMateMemoryGeneration(input: {
  appSettings: Pick<AppSettings, "memoryGenerationEnabled">;
  mateState: MateStorageState | null | undefined;
  growthSettings: Pick<MateGrowthSettings, "enabled" | "memoryCandidateMode"> | null | undefined;
}): boolean {
  if (!input.appSettings.memoryGenerationEnabled || input.mateState !== "active") {
    return false;
  }

  const growthSettings = input.growthSettings;
  if (!growthSettings?.enabled) {
    return false;
  }

  return growthSettings.memoryCandidateMode === "every_turn";
}
