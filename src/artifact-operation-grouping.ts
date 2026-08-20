import type { AuditLogOperation } from "./runtime-state.js";

export type ArtifactOperationGroup = {
  type: string;
  operations: AuditLogOperation[];
};

export function groupArtifactOperations(
  operations: readonly AuditLogOperation[],
): ArtifactOperationGroup[] {
  const groups: ArtifactOperationGroup[] = [];

  for (const operation of operations) {
    const previousGroup = groups.at(-1);
    if (previousGroup?.type === operation.type) {
      previousGroup.operations.push(operation);
      continue;
    }

    groups.push({
      type: operation.type,
      operations: [operation],
    });
  }

  return groups;
}
