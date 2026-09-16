import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SessionAuthorityError } from "../../src/session-authority.js";
import { buildNewSession } from "../../src/session-state.js";
import {
  issueTrustedCrossRootTransferCapability,
  transferSessionAuthority,
} from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-05T12:00:00.000Z";

function root(id: string) {
  return {
    ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
      branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
      rootSessionRole: "overall-coordinator" }),
    updatedAt: NOW,
  };
}

function trustedProof(rootSessionId: string) {
  return {
    principal: { kind: "system" as const, service: "root-transfer-test" }, providerId: null,
    operation: "session.move" as const, mappingRevision: 2, action: "session.move" as const,
    effectClass: "local_mutation" as const, grantId: null, grantRevision: null,
    resolvedScope: { resourceKind: "session" as const, resourceId: rootSessionId,
      rootSessionId, ownerKind: "session" as const, ownerId: rootSessionId, relation: "root_owner" as const },
    evaluatedAt: NOW,
  };
}

describe("Session authority root transfer", () => {
  // @test-value v2
  // kind = "security"
  // claim = "whole-root transfer retires only the exact trusted source transfer capability"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
  // fault = "source transfer capability is copied into the destination or another root's capability is accepted for retirement"
  // observable = "source capability revoked without replacement; another root's capability rejected with AUTHORITY_SCOPE_INVALID"
  // observation_boundary = "component-behavior"
  // scope = "session-authority-root-transfer"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("whole-root移管でsource transfer capabilityだけを失効させる", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-authority-transfer-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(root("root-a"));
    storage.insertSession(root("root-b"));
    storage.insertSession(root("root-c"));
    const db = new DatabaseSync(dbPath);
    try {
      const source = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-a", destinationRootSessionId: "root-a",
        destinationTargetRoles: ["overall-coordinator"], principal: trustedProof("root-a").principal,
        proof: trustedProof("root-a"), expiresAt: null, issuedAt: NOW,
      })[0]!;
      const destination = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-b", destinationRootSessionId: "root-b",
        destinationTargetRoles: ["overall-coordinator"], principal: trustedProof("root-b").principal,
        proof: trustedProof("root-b"), expiresAt: null, issuedAt: NOW,
      })[0]!;

      transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-1", transferredAt: NOW,
        retireSourceTransferCapabilityGrantId: source.grantId,
      });
      const retired = db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
        .get(source.grantId) as { revoked_at: string | null };
      assert.equal(retired.revoked_at, NOW);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE json_extract(provenance_json, '$.supersedesGrantId') = ?")
        .get(source.grantId) as { count: number }).count, 0);

      const wrongRootCapability = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-c", destinationRootSessionId: "root-c",
        destinationTargetRoles: ["overall-coordinator"], principal: trustedProof("root-c").principal,
        proof: trustedProof("root-c"), expiresAt: null, issuedAt: NOW,
      })[0]!;
      assert.throws(() => transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-2", transferredAt: NOW,
        retireSourceTransferCapabilityGrantId: wrongRootCapability.grantId,
      }), (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_SCOPE_INVALID");
    } finally {
      db.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
