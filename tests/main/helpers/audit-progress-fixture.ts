import type { AuditLogProgressAck, AuditLogProgressPatch } from "../../../src-shared/session/runtime-state.js";

export function createAuditProgressWriter(): (_id: number, patch: AuditLogProgressPatch) => AuditLogProgressAck {
  let nextOutputId = 1;
  return (_id, patch) => ({
    insertedOperations: (patch.operationUpserts ?? [])
      .filter((entry) => entry.outputId === undefined)
      .map(({ key }) => ({ key, outputId: nextOutputId++ })),
  });
}
