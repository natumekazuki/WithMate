import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import type { MutationAuthorityProof } from "../../src/session-authority.js";
import { SESSION_AUTHORITY_MAPPING_REVISION } from "../../src/session-authority.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { applySessionMove } from "../../src-electron/session-lifecycle-move.js";
import { issueTrustedCrossRootTransferCapability } from "../../src-electron/session-authority-storage.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { verifyResourceHistoryProjections } from "../../src-electron/resource-history-schema.js";

const CREATED_AT = "2026-09-11T00:00:00.000Z";
const MOVED_AT = "2026-09-12T00:00:00.000Z";
const EXPIRES_AT = "2026-09-13T00:00:00.000Z";

function root(id: string): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    rootSessionRole: "overall-coordinator" }), updatedAt: CREATED_AT };
}

function child(id: string, parent: Session): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, "executor") }), updatedAt: CREATED_AT };
}

function proof(operation: MutationAuthorityProof["operation"], resourceId: string): MutationAuthorityProof {
  return { principal: { kind: "system", service: "resource-history-cross-root-test" }, operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: operation,
    resolvedScope: { resourceKind: operation.startsWith("turn.") ? "execution" : "session", resourceId,
      rootSessionId: "root-a", ownerKind: "session", ownerId: "root-a", relation: "root_owner" },
    effectClass: operation.startsWith("turn.") ? "external_side_effect" : "local_mutation",
    grantId: null, grantRevision: null, evaluatedAt: CREATED_AT };
}

function moveProof(grant: { grantId: string; revision: number }): MutationAuthorityProof {
  return { ...proof("session.move", "root-a"), resolvedScope: { resourceKind: "session", resourceId: null,
    rootSessionId: "root-a", ownerKind: "session", ownerId: "root-a", relation: "root_owner" },
    principal: { kind: "agent", agent: "session-runtime", actorSessionId: "root-a", runtimeGeneration: "generation-1" },
    providerId: "internal", grantId: grant.grantId, grantRevision: grant.revision };
}

// @test-value v2
// kind = "regression"
// claim = "bindingなしのexecution fixtureでもcross-root move後の履歴検証は当時の旧rootを保持し、改ざんされたheaderを拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Session identity と変更可能性" }
// fault = "bindingなしの旧executionを現在role bindingで再計算し、旧root履歴をstartup failureにするか、header改ざんを見逃す"
// observable = "実SessionStorage/ExecutionStorageとapplySessionMove後のverifyResourceHistoryProjections"
// observation_boundary = "consumer"
// scope = "resource history execution header verification"
// lifecycle = "permanent"
// distinction = "実enqueue、terminal、cross-root move後にbinding欠落を模擬した履歴を検証する。旧DB backfill全体ではなく、履歴verifierの旧root保持とheader tamper rejectionが対象"
// @end-test-value
test("cross-root移動後のlegacy execution headerは旧rootを保持し改ざんを拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-cross-root-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessionStorage = new SessionStorageV6(dbPath);
  const executionStorage = new SessionExecutionStorageV6(dbPath);
  try {
    const sourceRoot = root("root-a");
    const destinationRoot = root("root-b");
    const target = child("executor-a", sourceRoot);
    sessionStorage.insertSession(sourceRoot);
    sessionStorage.insertSession(destinationRoot);
    sessionStorage.insertSession(target);

    const queued = executionStorage.enqueue({
      id: "execution-legacy", expectedContainerRevision: executionStorage.getSessionContainerRevision(target.id),
      sessionId: target.id, request: { userMessage: "before move" }, idempotencyKey: "legacy-enqueue",
      requestFingerprint: "legacy-fingerprint", createdAt: CREATED_AT, expiresAt: EXPIRES_AT,
      proof: proof("turn.enqueue", target.id),
    });
    executionStorage.admitNextQueued(target.id, CREATED_AT);
    executionStorage.completeRunning({ executionId: queued.execution.id, state: "completed", result: { ok: true },
      errorCode: "", reason: "", completedAt: CREATED_AT, expiresAt: EXPIRES_AT });

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DROP TRIGGER IF EXISTS session_execution_events_no_update_v6");
      db.prepare("UPDATE session_execution_events_v6 SET payload_json = json_remove(payload_json, '$.binding') WHERE execution_id = ?")
        .run(queued.execution.id);
      const [grant] = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: sourceRoot.id, destinationRootSessionId: sourceRoot.id,
        destinationTargetRoles: ["executor"], principal: { kind: "system", service: "resource-history-cross-root-test" },
        proof: { ...proof("session.move", sourceRoot.id), resolvedScope: { resourceKind: "session", resourceId: null,
          rootSessionId: destinationRoot.id, ownerKind: "session", ownerId: destinationRoot.id, relation: "root_owner" } },
        expiresAt: null, issuedAt: MOVED_AT,
      });
      const [destinationGrant] = issueTrustedCrossRootTransferCapability(db, {
        sourceActorSessionId: sourceRoot.id, destinationRootSessionId: destinationRoot.id,
        destinationTargetRoles: ["executor"], principal: { kind: "system", service: "resource-history-cross-root-test" },
        proof: { ...proof("session.move", destinationRoot.id), resolvedScope: { resourceKind: "session", resourceId: null,
          rootSessionId: destinationRoot.id, ownerKind: "session", ownerId: destinationRoot.id, relation: "root_owner" } },
        expiresAt: null, issuedAt: MOVED_AT,
      });
      applySessionMove(db, { sessionId: target.id, expectedRevision: 2, kind: "cross_root",
        destinationRootSessionId: destinationRoot.id, destinationParentSessionId: destinationRoot.id,
        destinationExpectedRevision: 1, transferManifestRevision: 2, transferPolicy: "full",
        destinationProof: { ...moveProof(destinationGrant), resolvedScope: { resourceKind: "session", resourceId: null,
          rootSessionId: destinationRoot.id, ownerKind: "session", ownerId: destinationRoot.id, relation: "root_owner" } },
      }, moveProof(grant), MOVED_AT, "move-legacy-execution");
      ensureV6Schema(db);
      verifyResourceHistoryProjections(db);
      db.exec("DROP TRIGGER resource_event_headers_no_delete_v6; DROP TRIGGER resource_event_headers_no_update_v6");
      db.prepare("UPDATE resource_event_headers_v6 SET root_id = ? WHERE resource_kind = 'execution' AND resource_id = ?")
        .run(destinationRoot.id, queued.execution.id);
      assert.throws(() => verifyResourceHistoryProjections(db), /rootId/);
    } finally {
      db.close();
    }
  } finally {
    executionStorage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
