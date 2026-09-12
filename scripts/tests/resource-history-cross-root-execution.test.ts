import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { SessionInteractionStorageV6 } from "../../src-electron/session-interaction-storage-v6.js";
import { SessionTranscriptStorageV6 } from "../../src-electron/session-transcript-storage-v6.js";
import { applySessionMove } from "../../src-electron/session-lifecycle-move.js";
import { issueTrustedCrossRootTransferCapability } from "../../src-electron/session-authority-storage.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { verifyResourceHistoryProjections } from "../../src-electron/resource-history-schema.js";

const CREATED_AT = "2026-09-11T00:00:00.000Z";
const MOVED_AT = "2026-09-12T00:00:00.000Z";
const EXPIRES_AT = "2026-09-13T00:00:00.000Z";
const FILE_SHA256 = createHash("sha256").update("file-history").digest("hex");
const TRANSCRIPT_SHA256 = createHash("sha256").update("transcript-history").digest("hex");

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
  const resourceKind = operation === "turn.enqueue" || operation === "turn.run" || operation === "turn.cancel"
    ? "execution"
    : operation === "session.files.write_text"
      ? "session_files"
      : operation === "transcript.export"
        ? "transcript"
        : operation === "interaction.respond"
          ? "interaction"
          : "session";
  return { principal: { kind: "system", service: "resource-history-cross-root-test" }, operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: operation,
    resolvedScope: { resourceKind, resourceId,
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

// @test-value v2
// kind = "regression"
// claim = "同一SessionをAからBを経由してCへ移動してもfile write、transcript export、answered interactionの履歴は各時点のrootで検証され、改ざんされたroot headerを拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Session identity と変更可能性" }
// fault = "Saga／interactionの完了履歴を現在root Cで再計算してstartup検証を誤拒否するか、A/Bのheader改ざんを見逃す"
// observable = "実SessionStorage、SessionExecutionStorage、SessionInteractionStorage、SessionTranscriptStorageとA->B->C実move後のverifyResourceHistoryProjections"
// observation_boundary = "consumer"
// scope = "resource history cross-root header verification"
// lifecycle = "permanent"
// distinction = "実canonical storageのprepared／completed sagaとanswered interactionをA rootで作成し、2回の実move後にold header rootを確認してから、tamper rejectionを確認する"
// @end-test-value
test("cross-rootを二度経由したfile・transcript・answered interaction履歴は各時点のrootを保持する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-cross-root-history-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessionStorage = new SessionStorageV6(dbPath);
  const executionStorage = new SessionExecutionStorageV6(dbPath);
  const interactionStorage = new SessionInteractionStorageV6(dbPath);
  const transcriptStorage = new SessionTranscriptStorageV6(dbPath);
  try {
    const sourceRoot = root("root-a");
    const middleRoot = root("root-b");
    const destinationRoot = root("root-c");
    const target = child("executor-a", sourceRoot);
    sessionStorage.insertSession(sourceRoot);
    sessionStorage.insertSession(middleRoot);
    sessionStorage.insertSession(destinationRoot);
    sessionStorage.insertSession(target);

    const queued = executionStorage.enqueue({
      id: "execution-cross-root-history", expectedContainerRevision: executionStorage.getSessionContainerRevision(target.id),
      sessionId: target.id, request: { userMessage: "cross-root history" }, idempotencyKey: "cross-root-history-enqueue",
      requestFingerprint: "cross-root-history-fingerprint", createdAt: CREATED_AT, expiresAt: EXPIRES_AT,
      proof: proof("turn.enqueue", target.id),
    });
    executionStorage.admitNextQueued(target.id, CREATED_AT);

    const interaction = interactionStorage.createPending({
      id: "interaction-cross-root-history", sessionId: target.id, executionId: queued.execution.id,
      kind: "approval", publicPayload: { title: "approve", message: "approve" }, createdAt: CREATED_AT,
    });
    interactionStorage.respond({
      sessionId: target.id, executionId: queued.execution.id, interactionId: interaction.id, expectedRevision: interaction.revision,
      principal: { kind: "user" }, action: "approve", submittedFields: [], idempotencyKey: "interaction-cross-root-history-answer",
      requestFingerprint: "interaction-cross-root-history-answer-fingerprint", respondedAt: CREATED_AT, expiresAt: EXPIRES_AT,
    });

    const fileProof = proof("session.files.write_text", target.id);
    const preparedFile = sessionStorage.prepareSessionFileWrite({
      idempotencyKey: "file-cross-root-history", requestFingerprint: "file-cross-root-history-fingerprint", sessionId: target.id,
      relativePath: "history.txt", tempName: ".history.tmp", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: fileProof,
    });
    assert.equal(preparedFile.kind, "pending");
    const fileOutput = { sha256: FILE_SHA256, byteLength: 12, device: "device-a", inode: "inode-a", targetPrecondition: { kind: "absent" } as const };
    sessionStorage.recordPreparedSessionFileWrite({ proof: fileProof, idempotencyKey: "file-cross-root-history", requestFingerprint: "file-cross-root-history-fingerprint", prepared: fileOutput });
    sessionStorage.completeSessionFileWrite({ proof: fileProof, idempotencyKey: "file-cross-root-history", requestFingerprint: "file-cross-root-history-fingerprint", prepared: fileOutput, result: { ok: true }, completedAt: CREATED_AT, expiresAt: EXPIRES_AT });

    const transcriptProof = proof("transcript.export", target.id);
    const preparedTranscript = transcriptStorage.prepareExport({
      idempotencyKey: "transcript-cross-root-history", requestFingerprint: "transcript-cross-root-history-fingerprint", sessionId: target.id,
      relativePath: "transcript.md", tempName: ".transcript.tmp", createdAt: CREATED_AT, expiresAt: EXPIRES_AT, proof: transcriptProof,
    });
    assert.equal(preparedTranscript.kind, "pending");
    const targetPrecondition = { kind: "absent" } as const;
    transcriptStorage.recordPreparedOutput({ proof: transcriptProof, idempotencyKey: "transcript-cross-root-history", requestFingerprint: "transcript-cross-root-history-fingerprint", outputSha256: TRANSCRIPT_SHA256, byteLength: 20, outputDevice: "device-a", outputInode: "inode-t", targetPrecondition });
    transcriptStorage.completeExport({ proof: transcriptProof, idempotencyKey: "transcript-cross-root-history", requestFingerprint: "transcript-cross-root-history-fingerprint", outputSha256: TRANSCRIPT_SHA256, byteLength: 20, outputDevice: "device-a", outputInode: "inode-t", targetPrecondition, result: { ok: true }, completedAt: CREATED_AT, expiresAt: EXPIRES_AT });

    executionStorage.completeRunning({ executionId: queued.execution.id, state: "completed", result: { ok: true }, errorCode: "", reason: "", completedAt: CREATED_AT, expiresAt: EXPIRES_AT });

    const db = new DatabaseSync(dbPath);
    try {
      const move = (destinationRootSessionId: string, expectedRevision: number, operationId: string) => {
        const [sourceGrant] = issueTrustedCrossRootTransferCapability(db, {
          sourceActorSessionId: sourceRoot.id, destinationRootSessionId: sourceRoot.id, destinationTargetRoles: ["executor"],
          principal: { kind: "system", service: "resource-history-cross-root-test" }, proof: proof("session.move", sourceRoot.id), expiresAt: null, issuedAt: MOVED_AT,
        });
        const [destinationGrant] = issueTrustedCrossRootTransferCapability(db, {
          sourceActorSessionId: sourceRoot.id, destinationRootSessionId, destinationTargetRoles: ["executor"],
          principal: { kind: "system", service: "resource-history-cross-root-test" }, proof: { ...proof("session.move", destinationRootSessionId), resolvedScope: { resourceKind: "session", resourceId: null, rootSessionId: destinationRootSessionId, ownerKind: "session", ownerId: destinationRootSessionId, relation: "root_owner" } }, expiresAt: null, issuedAt: MOVED_AT,
        });
        applySessionMove(db, { sessionId: target.id, expectedRevision, kind: "cross_root", destinationRootSessionId, destinationParentSessionId: destinationRootSessionId, destinationExpectedRevision: 1, transferManifestRevision: expectedRevision, transferPolicy: "full", destinationProof: { ...moveProof(destinationGrant), resolvedScope: { resourceKind: "session", resourceId: null, rootSessionId: destinationRootSessionId, ownerKind: "session", ownerId: destinationRootSessionId, relation: "root_owner" } } }, moveProof(sourceGrant), MOVED_AT, operationId);
      };
      move(middleRoot.id, 2, "move-history-a-b");
      move(destinationRoot.id, 3, "move-history-b-c");
      ensureV6Schema(db);
      verifyResourceHistoryProjections(db);

      const headers = db.prepare("SELECT resource_kind, resource_id, event_kind, root_id FROM resource_event_headers_v6 ORDER BY sequence").all() as Array<{ resource_kind: string; resource_id: string; event_kind: string; root_id: string }>;
      const oldResourceHeaders = headers.filter((row) => ["execution", "session_files", "transcript", "interaction"].includes(row.resource_kind));
      assert.ok(oldResourceHeaders.some((row) => row.resource_kind === "execution"));
      assert.ok(oldResourceHeaders.some((row) => row.resource_kind === "session_files"));
      assert.ok(oldResourceHeaders.some((row) => row.resource_kind === "transcript"));
      assert.ok(oldResourceHeaders.some((row) => row.resource_kind === "interaction"));
      for (const header of oldResourceHeaders) assert.equal(header.root_id, sourceRoot.id, JSON.stringify(header));
      assert.ok(headers.some((row) => row.root_id === middleRoot.id));
      assert.ok(headers.some((row) => row.root_id === destinationRoot.id));

      db.exec("DROP TRIGGER resource_event_headers_no_delete_v6; DROP TRIGGER resource_event_headers_no_update_v6");
      db.prepare("UPDATE resource_event_headers_v6 SET root_id = ? WHERE resource_kind = 'interaction' AND resource_id = ? AND root_id = ?")
        .run(destinationRoot.id, interaction.id, sourceRoot.id);
      assert.throws(() => verifyResourceHistoryProjections(db), /rootId/);
    } finally {
      db.close();
    }
  } finally {
    transcriptStorage.close();
    interactionStorage.close();
    executionStorage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
