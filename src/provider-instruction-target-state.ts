export type ProviderInstructionWriteMode = "managed_file" | "managed_block";
export type ProviderInstructionFailPolicy = "block_session" | "warn_continue";
export type ProviderInstructionLastSyncState =
  | "never"
  | "stale"
  | "redaction_required"
  | "synced"
  | "skipped"
  | "failed";
export type ProviderInstructionSyncStatus = "synced" | "skipped" | "failed";

export type ProviderInstructionTarget = {
  providerId: string;
  targetId: string;
  enabled: boolean;
  rootDirectory: string;
  instructionRelativePath: string;
  writeMode: ProviderInstructionWriteMode;
  projectionScope: "mate_only";
  failPolicy: ProviderInstructionFailPolicy;
  requiresRestart: boolean;
  lastSyncState: ProviderInstructionLastSyncState;
  lastSyncRunId: number | null;
  lastSyncedRevisionId: string | null;
  lastErrorPreview: string;
  lastSyncedAt: string | null;
};

export type ProviderInstructionTargetInput = {
  providerId: string;
  targetId?: string;
  enabled: boolean;
  rootDirectory: string;
  instructionRelativePath: string;
  writeMode: ProviderInstructionWriteMode;
  failPolicy: ProviderInstructionFailPolicy;
  requiresRestart?: boolean;
};

export type ProviderInstructionTargetUpdate = Partial<Omit<ProviderInstructionTargetInput, "providerId" | "targetId">> & {
  providerId: string;
  targetId?: string;
};
