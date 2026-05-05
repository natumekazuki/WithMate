import type { MateProfile } from "../src/mate-state.js";
import type {
  ProviderInstructionTarget,
  ProviderInstructionTargetInput,
} from "../src/provider-instruction-target-state.js";
import type { MateProviderInstructionSyncDeps } from "./mate-provider-instruction-sync.js";

type ProviderInstructionTargetStorageLike = {
  getTarget(providerId: string, targetId?: string): ProviderInstructionTarget | null;
  upsertTarget(input: ProviderInstructionTargetInput): ProviderInstructionTarget;
};

export type UpsertProviderInstructionTargetCommandDeps<
  TStorage extends ProviderInstructionTargetStorageLike = ProviderInstructionTargetStorageLike,
> = {
  storage: TStorage;
  getMateProfile(): MateProfile | null;
  syncEnabledProviderInstructionTargetsForMateProfile(profile: MateProfile): Promise<void>;
  syncDisabledProviderInstructionTarget: (
    storage: TStorage,
    target: ProviderInstructionTarget,
    deps: MateProviderInstructionSyncDeps,
    syncOptions?: { protectedRoots?: readonly string[] },
  ) => Promise<unknown>;
  protectedRoots: readonly string[];
  syncDeps: MateProviderInstructionSyncDeps;
  assertProviderInstructionTargetRootNotProtected(
    input: ProviderInstructionTargetInput,
    protectedRoots: readonly string[],
  ): void;
  logDisabledCleanupFailure(error: unknown, previousTarget: ProviderInstructionTarget): void | Promise<void>;
};

export async function upsertProviderInstructionTargetCommand<TStorage extends ProviderInstructionTargetStorageLike>(
  input: ProviderInstructionTargetInput,
  deps: UpsertProviderInstructionTargetCommandDeps<TStorage>,
): Promise<ProviderInstructionTarget> {
  deps.assertProviderInstructionTargetRootNotProtected(input, deps.protectedRoots);

  const previousTarget = deps.storage.getTarget(input.providerId, input.targetId);
  const target = deps.storage.upsertTarget(input);

  if (!target.enabled && previousTarget && previousTarget.enabled) {
    try {
      await deps.syncDisabledProviderInstructionTarget(
        deps.storage,
        previousTarget,
        deps.syncDeps,
        { protectedRoots: deps.protectedRoots },
      );
    } catch (error) {
      await deps.logDisabledCleanupFailure(error, previousTarget);
    }
  }

  if (target.enabled) {
    const profile = deps.getMateProfile();
    if (profile) {
      await deps.syncEnabledProviderInstructionTargetsForMateProfile(profile);
    }
  }

  return deps.storage.getTarget(target.providerId, target.targetId) ?? target;
}
