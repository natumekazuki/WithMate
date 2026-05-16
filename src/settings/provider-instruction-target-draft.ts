import {
  DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID,
  getDefaultProviderInstructionRelativePath,
  type ProviderInstructionFailPolicy,
  type ProviderInstructionTargetSettings,
  type ProviderInstructionWriteMode,
} from "../provider-settings-state.js";

export type HomeProviderInstructionTargetDraft = ProviderInstructionTargetSettings;

export function normalizeProviderInstructionTarget(
  target: ProviderInstructionTargetSettings,
): HomeProviderInstructionTargetDraft {
  return target;
}

export function buildFallbackProviderInstructionTarget(providerId: string): HomeProviderInstructionTargetDraft {
  return {
    providerId,
    targetId: DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID,
    enabled: false,
    rootDirectory: "",
    instructionRelativePath: getDefaultProviderInstructionRelativePath(providerId),
    lastSyncState: "never",
    lastSyncRunId: null,
    lastSyncedRevisionId: null,
    lastErrorPreview: "",
    lastSyncedAt: null,
    writeMode: "managed_block",
    projectionScope: "mate_only",
    failPolicy: "warn_continue",
    requiresRestart: false,
  };
}

export function isProviderInstructionWriteMode(value: string): value is ProviderInstructionWriteMode {
  return value === "managed_file" || value === "managed_block";
}

export function isProviderInstructionFailPolicy(value: string): value is ProviderInstructionFailPolicy {
  return value === "block_session" || value === "warn_continue";
}
