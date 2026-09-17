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
  issueTrustedGrantPolicy,
  transferSessionAuthority,
} from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-05T12:00:00.000Z";
const ALL_ROLES = ["standalone", "overall-coordinator", "task-coordinator", "executor"] as const;

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
  // fault = "source transfer capability is copied into the destination, another root's capability, or a same-root ordinary policy is accepted for retirement"
  // observable = "source capability revoked without replacement; non-transfer capability inputs rejected with AUTHORITY_SCOPE_INVALID"
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
        destinationTargetRoles: ALL_ROLES, principal: trustedProof("root-a").principal,
        proof: trustedProof("root-a"), expiresAt: null, issuedAt: NOW,
      })[0]!;
      const destination = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-b", destinationRootSessionId: "root-b",
        destinationTargetRoles: ALL_ROLES, principal: trustedProof("root-b").principal,
        proof: trustedProof("root-b"), expiresAt: null, issuedAt: NOW,
      })[0]!;

      const wrongRootCapability = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-c", destinationRootSessionId: "root-c",
        destinationTargetRoles: ALL_ROLES, principal: trustedProof("root-c").principal,
        proof: trustedProof("root-c"), expiresAt: null, issuedAt: NOW,
      })[0]!;
      const ordinaryMovePolicy = issueTrustedGrantPolicy(db, {
        rootSessionId: "root-a", granteeSessionId: "root-a", actions: ["session.get"],
        resourceKind: "session", relationSelector: "root_member", targetSessionRoles: ["executor"],
        effectClass: "read", delegable: false, childCeiling: [], expiresAt: null,
        principal: { kind: "system", service: "ordinary-move-policy" },
        proof: { ...trustedProof("root-a"), principal: { kind: "system", service: "ordinary-move-policy" }, operation: "session.get", action: "session.get", effectClass: "read" },
        issuedAt: NOW,
      })[0]!;
      assert.throws(() => transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-wrong", transferredAt: NOW,
        retireSourceTransferCapabilityGrantId: wrongRootCapability.grantId,
      }), (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_SCOPE_INVALID");
      for (const grantId of [source.grantId, wrongRootCapability.grantId]) {
        assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?").get(grantId) as { revoked_at: string | null }).revoked_at, null);
      }
      assert.throws(() => transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-ordinary-policy", transferredAt: NOW,
        retireSourceTransferCapabilityGrantId: ordinaryMovePolicy.grantId,
      }), (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_SCOPE_INVALID");
      assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
        .get(ordinaryMovePolicy.grantId) as { revoked_at: string | null }).revoked_at, null);
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

      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id='root-a' AND root_session_id='root-b' AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value='session.move')")
        .get() as { count: number }).count, 0);
    } finally {
      db.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "cross-root transfer rejects a source grant whose delegation mode exceeds the destination exercise ceiling"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
  // fault = "destination transfer capability permits the source permission only in exercise mode while the source grant remains delegable"
  // observable = "transfer fails with AUTHORITY_FORBIDDEN before the source grant is revoked"
  // observation_boundary = "component-behavior"
  // scope = "session-authority-root-transfer"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("移管先のexercise ceilingではdelegableなsource grantを持ち込めない", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-authority-transfer-mode-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(root("root-a"));
    storage.insertSession(root("root-b"));
    const db = new DatabaseSync(dbPath);
    try {
      const source = issueTrustedGrantPolicy(db, {
        rootSessionId: "root-a", granteeSessionId: "root-a", actions: ["session.get"],
        resourceKind: "session", relationSelector: "root_member", targetSessionRoles: ["executor"],
        effectClass: "read", delegable: true,
        childCeiling: [{ mode: "exercise", action: "session.get", resourceKind: "session", relationSelector: "root_member", effectClass: "read", targetSessionRoles: ["executor"] }],
        expiresAt: null, principal: { kind: "system", service: "mode-transfer-test" },
        proof: { principal: { kind: "system", service: "mode-transfer-test" }, operation: "session.get", mappingRevision: 2, action: "session.get", resolvedScope: { resourceKind: "session", resourceId: "root-a", rootSessionId: "root-a", ownerKind: "session", ownerId: "root-a", relation: "root_member" }, effectClass: "read", grantId: null, grantRevision: null, evaluatedAt: NOW },
        issuedAt: NOW,
      })[0]!;
      const destination = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationTargetRoles: ALL_ROLES, principal: trustedProof("root-b").principal,
        proof: trustedProof("root-b"), expiresAt: null, issuedAt: NOW,
      })[0]!;

      assert.throws(() => transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-mode", transferredAt: NOW,
      }), (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN");
      assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
        .get(source.grantId) as { revoked_at: string | null }).revoked_at, null);
    } finally {
      db.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "cross-root transfer accepts an exercise-only source grant within the destination ceiling"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
  // fault = "transfer rejects an exercise source grant even though the destination ceiling permits the same exercise permission"
  // observable = "source grant is revoked and a destination-root replacement grant is persisted"
  // observation_boundary = "component-behavior"
  // scope = "session-authority-root-transfer"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("移管先のexercise ceilingに収まるsource grantは移管できる", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-authority-transfer-exercise-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(root("root-a"));
    storage.insertSession(root("root-b"));
    const db = new DatabaseSync(dbPath);
    try {
      const source = issueTrustedGrantPolicy(db, {
        rootSessionId: "root-a", granteeSessionId: "root-a", actions: ["session.get"],
        resourceKind: "session", relationSelector: "root_member", targetSessionRoles: ["executor"],
        effectClass: "read", delegable: false, childCeiling: [], expiresAt: null,
        principal: { kind: "system", service: "exercise-transfer-test" },
        proof: { principal: { kind: "system", service: "exercise-transfer-test" }, operation: "session.get", mappingRevision: 2, action: "session.get", resolvedScope: { resourceKind: "session", resourceId: "root-a", rootSessionId: "root-a", ownerKind: "session", ownerId: "root-a", relation: "root_member" }, effectClass: "read", grantId: null, grantRevision: null, evaluatedAt: NOW },
        issuedAt: NOW,
      })[0]!;
      const destination = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationTargetRoles: ALL_ROLES, principal: trustedProof("root-b").principal,
        proof: trustedProof("root-b"), expiresAt: null, issuedAt: NOW,
      })[0]!;

      const transferred = transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-exercise", transferredAt: NOW,
      });
      assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
        .get(source.grantId) as { revoked_at: string | null }).revoked_at, NOW);
      assert.ok(transferred.some((grant) => grant.provenance.supersedesGrantId === source.grantId));
    } finally {
      db.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "cross-root transfer checks a source grant's child ceiling against the destination ceiling"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
  // fault = "the source grant permission fits the destination ceiling but its nonempty child ceiling exceeds the destination scope"
  // observable = "transfer fails with AUTHORITY_FORBIDDEN before the source grant is revoked"
  // observation_boundary = "component-behavior"
  // scope = "session-authority-root-transfer"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("移管先ceilingに収まらないsource child ceilingを拒否する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-authority-transfer-child-ceiling-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(root("root-a"));
    storage.insertSession(root("root-b"));
    const db = new DatabaseSync(dbPath);
    try {
      const sourceRow = db.prepare("SELECT grant_id, target_session_roles_json, child_ceiling_json\n        FROM session_authority_grants_v6\n        WHERE grantee_session_id = 'root-a' AND root_session_id = 'root-a'\n          AND json_extract(provenance_json, '$.source') = 'role-baseline'\n          AND EXISTS (SELECT 1 FROM json_each(actions_json) WHERE value = 'session.create')\n        LIMIT 1").get() as { grant_id: string; target_session_roles_json: string; child_ceiling_json: string } | undefined;
      assert.ok(sourceRow);
      const sourceTargetRoles = JSON.parse(sourceRow.target_session_roles_json) as string[];
      const sourceChildCeiling = JSON.parse(sourceRow.child_ceiling_json) as Array<Record<string, unknown>>;
      const destination = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationTargetRoles: ALL_ROLES, principal: trustedProof("root-b").principal,
        proof: trustedProof("root-b"), expiresAt: null, issuedAt: NOW,
      })[0]!;
      const ceiling = JSON.parse((db.prepare("SELECT child_ceiling_json FROM session_authority_grants_v6 WHERE grant_id = ?")
        .get(destination.grantId) as { child_ceiling_json: string }).child_ceiling_json) as Array<Record<string, unknown>>;
      assert.ok(ceiling.some((item) => item.action === "session.create" && item.mode === "delegate"
        && item.relationSelector === "self"
        && sourceTargetRoles.every((role) => (item.targetSessionRoles as string[]).includes(role))));
      assert.ok(sourceChildCeiling.some((item) => item.action === "turn.enqueue" && item.relationSelector === "parent"));
      const narrowedCeiling = ceiling.filter((item) => !(item.action === "turn.enqueue" && item.relationSelector === "parent"));
      db.prepare("UPDATE session_authority_grants_v6 SET child_ceiling_json = ? WHERE grant_id = ?")
        .run(JSON.stringify(narrowedCeiling), destination.grantId);

      assert.throws(() => transferSessionAuthority(db, {
        sessionId: "root-a", sourceRootSessionId: "root-a", destinationRootSessionId: "root-b",
        destinationIssuerGrantId: destination.grantId, destinationIssuerGrantRevision: destination.revision,
        operationId: "root-transfer-child-ceiling", transferredAt: NOW,
      }), (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN");
      assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
        .get(sourceRow.grant_id) as { revoked_at: string | null }).revoked_at, null);
    } finally {
      db.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
