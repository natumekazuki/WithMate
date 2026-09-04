import {
  getRuntimeDiscoveryLeaseState,
  isRuntimeDiscoverySelector,
  toSafeRuntimeDiscoveryMetadata,
  type RuntimeDiscoveryRegistryLimits,
  type RuntimeDiscoverySelectionOutcomeCode,
  type RuntimeDiscoverySelector,
  type SafeRuntimeDiscoveryMetadata,
} from "./runtime-discovery-contract.js";
import type {
  RuntimeDiscoveryRegistryChallenge,
  RuntimeDiscoveryRegistryRecord,
} from "./runtime-discovery-registry.js";

export type RuntimeDiscoveryRecordSelectionOutcome =
  | {
      kind: "selected";
      record: RuntimeDiscoveryRegistryRecord;
      metadata: SafeRuntimeDiscoveryMetadata;
    }
  | {
      kind: "error";
      code: RuntimeDiscoverySelectionOutcomeCode;
      metadata: SafeRuntimeDiscoveryMetadata[];
    };

export async function selectRuntimeDiscoveryRecord(input: {
  records: readonly RuntimeDiscoveryRegistryRecord[];
  selector: RuntimeDiscoverySelector;
  now: Date;
  staleThresholdMs: RuntimeDiscoveryRegistryLimits["staleThresholdMs"];
  challenge: RuntimeDiscoveryRegistryChallenge;
}): Promise<RuntimeDiscoveryRecordSelectionOutcome> {
  if (!isRuntimeDiscoverySelector(input.selector)) {
    return error("runtime_selector_invalid", []);
  }

  const runtimeRecords = input.records.filter(
    ({ entry }) => entry.runtimeKind === input.selector.runtimeKind,
  );
  const sameApplication = input.selector.applicationInstanceId
    ? runtimeRecords.filter(
        ({ entry }) => entry.applicationInstanceId === input.selector.applicationInstanceId,
      )
    : runtimeRecords;
  if (input.selector.applicationInstanceId && sameApplication.length === 0) {
    return error(
      runtimeRecords.length > 0 ? "runtime_instance_mismatch" : "runtime_unavailable",
      runtimeRecords,
    );
  }

  const matching = input.selector.runtimeGenerationId
    ? sameApplication.filter(
        ({ entry }) => entry.runtimeGenerationId === input.selector.runtimeGenerationId,
      )
    : sameApplication;
  if (input.selector.runtimeGenerationId && matching.length === 0) {
    return error("runtime_generation_changed", sameApplication);
  }

  const active: RuntimeDiscoveryRegistryRecord[] = [];
  for (const record of matching) {
    if (getRuntimeDiscoveryLeaseState(record.entry, input.now, input.staleThresholdMs) === "fresh") {
      active.push(record);
      continue;
    }
    try {
      if (await input.challenge(record.entry, record.slotDirectoryPath)) {
        active.push(record);
      }
    } catch {
      // An expired lease needs a successful identity challenge to remain active.
    }
  }

  if (active.length === 0) {
    return error(matching.length > 0 ? "runtime_stale" : "runtime_unavailable", matching);
  }
  if (active.length > 1) {
    return error("runtime_ambiguous", matching);
  }
  const record = active[0]!;
  return {
    kind: "selected",
    record,
    metadata: toSafeRuntimeDiscoveryMetadata(record.entry, input.now, input.staleThresholdMs),
  };

  function error(
    code: RuntimeDiscoverySelectionOutcomeCode,
    records: readonly RuntimeDiscoveryRegistryRecord[],
  ): RuntimeDiscoveryRecordSelectionOutcome {
    return {
      kind: "error",
      code,
      metadata: records.map(({ entry }) =>
        toSafeRuntimeDiscoveryMetadata(entry, input.now, input.staleThresholdMs),
      ),
    };
  }
}
