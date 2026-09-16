import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { RESOURCE_BUDGET_DEFAULT_HARD_LIMITS } from "../../src/resource-budget.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  type MutationAuthorityProof,
  type SessionAuthorityGrant,
} from "../../src/session-authority.js";
import { buildChildSessionRoleBinding, type RootSessionRole, type SessionRole } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import { SessionLifecycleService } from "../../src-electron/session-lifecycle-service.js";
import { SessionLifecycleResolver } from "../../src-electron/session-lifecycle-resolver.js";
import { revokeSessionAuthorityGrant } from "../../src-electron/session-authority-storage.js";
import {
  issueTrustedCrossRootTransferCapability,
  listActiveSessionAuthorityGrants,
} from "../../src-electron/session-authority-storage.js";
import {
  ResourceBudgetStorage,
} from "../../src-electron/resource-budget-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";

const NOW = "2026-09-05T12:00:00.000Z";
const LATER = "2026-09-05T12:01:00.000Z";
const EXPIRES = "2026-10-05T12:00:00.000Z";
const ALL_ROLES = ["standalone", "overall-coordinator", "task-coordinator", "executor"] as const satisfies readonly SessionRole[];

function root(id: string, role: RootSessionRole): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    rootSessionRole: role }), updatedAt: NOW };
}

function child(id: string, parent: Session, role: "task-coordinator" | "executor"): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role) }), updatedAt: NOW };
}

function trustedMoveProof(rootSessionId: string): MutationAuthorityProof {
  return { principal: { kind: "system", service: "session-root-transfer-test" }, providerId: null,
    operation: "session.move", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "session.move",
    resolvedScope: { resourceKind: "session_namespace", resourceId: null, rootSessionId,
      ownerKind: "session", ownerId: rootSessionId, relation: "root_owner" }, effectClass: "local_mutation",
    grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function issueMoveGrant(db: DatabaseSync, sourceActorSessionId: string, destinationRootSessionId: string, roles: readonly SessionRole[] = ALL_ROLES): SessionAuthorityGrant {
  const before = new Set(listActiveSessionAuthorityGrants(db, sourceActorSessionId, new Date(NOW)).map((grant) => grant.grantId));
  const proof = trustedMoveProof(destinationRootSessionId);
  const issued = issueTrustedCrossRootTransferCapability(db, { sourceActorSessionId, destinationRootSessionId,
    destinationTargetRoles: roles, principal: { kind: "system", service: "session-root-transfer-test" },
    proof, expiresAt: null, issuedAt: NOW });
  const created = issued.find((grant) => !before.has(grant.grantId)
    && grant.provenance.source === "trusted-cross-root-transfer");
  assert.ok(created, `transfer grant was not created for ${destinationRootSessionId}`);
  return created;
}

function budgetProof(rootSessionId: string): MutationAuthorityProof {
  return { principal: { kind: "user", receiptId: `budget:${rootSessionId}` }, providerId: null,
    operation: "budget.configure", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "budget.configure",
    resolvedScope: { resourceKind: "budget", resourceId: rootSessionId, rootSessionId,
      ownerKind: "session", ownerId: rootSessionId, relation: "self" }, effectClass: "local_mutation",
    grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function workProof(rootSessionId: string, operation: "work.transition" | "work.result"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return { principal: { kind: "system", service: "session-root-transfer-test" }, providerId: null,
    operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action,
    resolvedScope: { resourceKind: definition.resourceKind, resourceId: `root-work-item:${rootSessionId}`,
      rootSessionId, ownerKind: "session", ownerId: rootSessionId, relation: "self" },
    effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function settleRootWork(db: DatabaseSync, rootSessionId: string): void {
  const storage = new WorkItemStorageV6(db);
  const workItemId = `root-work-item:${rootSessionId}`;
  const current = storage.get(workItemId);
  assert.ok(current);
  const active = storage.mutate({ operation: "work.transition", workItemId, principalSessionId: rootSessionId,
    idempotencyKey: `${workItemId}:start`, requestFingerprint: `${workItemId}:start:fp`,
    expectedRevision: current.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES,
    proof: workProof(rootSessionId, "work.transition") });
  storage.mutate({ operation: "work.result", workItemId, principalSessionId: rootSessionId,
    idempotencyKey: `${workItemId}:result`, requestFingerprint: `${workItemId}:result:fp`,
    expectedRevision: active.revision, state: "completed", result: { outcome: "completed",
      summary: "source root completed", changes: [], verificationResults: [], findings: [], unverifiedItems: [],
      remainingWork: [], reportingSessionId: rootSessionId, reportedAt: LATER }, updatedAt: LATER,
    expiresAt: EXPIRES, proof: workProof(rootSessionId, "work.result") });
  storage.close();
}

function enlargeDestinationBudget(db: DatabaseSync, destinationRootSessionId: string): void {
  const budgets = new ResourceBudgetStorage(db);
  const current = budgets.getByAccountId(destinationRootSessionId);
  budgets.configure({ sessionId: destinationRootSessionId, accountId: destinationRootSessionId,
    expectedRevision: current.revision,
    hardLimits: Object.fromEntries(Object.entries(RESOURCE_BUDGET_DEFAULT_HARD_LIMITS)
      .map(([dimension, value]) => [dimension, value * 10])),
    idempotencyKey: `enlarge:${destinationRootSessionId}` }, budgetProof(destinationRootSessionId), NOW);
  budgets.close();
}


function binding(sessionId: string) {
  return { bindingId: `binding-${sessionId}`, bindingIdHash: `hash-${sessionId}`, actorSessionId: sessionId,
    providerId: "codex", executionGeneration: "generation-1", authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"], createdAt: NOW, expiresAt: null };
}

async function fixture(actorIsChild: boolean, failPublish: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-transfer-public-"));
  const databasePath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(databasePath);
  const source = root("source", actorIsChild ? "overall-coordinator" : "standalone");
  const destination = root("destination", "standalone");
  storage.insertSession(source);
  storage.insertSession(destination);
  const controller = child("controller", source, "executor");
  if (actorIsChild) storage.insertSession(controller);
  const actorId = actorIsChild ? controller.id : source.id;
  const db = new DatabaseSync(databasePath);
  settleRootWork(db, source.id);
  enlargeDestinationBudget(db, destination.id);
  issueMoveGrant(db, actorId, source.id, actorIsChild ? ALL_ROLES : ["standalone"]);
  const destinationGrant = issueMoveGrant(db, actorId, destination.id, actorIsChild ? ALL_ROLES : ["standalone"]);
  let generation = "generation-1";
  const authority = new SessionAuthorityService({ databasePath, getExecutionGeneration: () => generation, now: () => new Date(LATER) });
  let publishFailure = failPublish;
  const published: string[] = [];
  const resolver = new SessionLifecycleResolver({ currentModelCatalog: () => null,
    isProviderEnabled: () => true, isProviderSupported: () => true, listCharacters: () => [],
    createCharacterRuntimeSnapshot: () => null, resolveSessionFilesDirectory: (id) => path.join(directory, id) });
  const lifecycle = new SessionLifecycleService({ storage, resolver,
    createSessionFilesDirectory: async (id) => path.join(directory, id), cleanupSessionFilesDirectory: async () => {},
    resolveSessionFilesDirectory: (id) => path.join(directory, id), publishRemovedSession: async () => {},
    publishSession: (session) => { if (publishFailure) throw new Error("injected publish failure"); published.push(session.id); },
    authorizeTransferDestination: (...args) => authority.authorizeTransferDestination(...args).proof,
    now: () => new Date(LATER) });
  const unused = (): never => { throw new Error("unexpected unrelated adapter call"); };
  const application = new SessionExternalApplicationService({ authorityService: authority, lifecycleService: lifecycle,
    crudService: { create: unused, list: unused, get: unused, rename: unused },
    executionService: { beginShutdown: unused, run: unused, enqueue: unused, get: unused, listPage: unused,
      cancel: unused, waitForTerminal: unused, resolveReplay: unused, resumeRootQueues: unused },
    currentModelCatalog: () => null, isProviderEnabled: () => true, isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [], resolveTurnInitiator: async () => null, getTurnAuthoritySession: () => null });
  const input = { sessionId: source.id, expectedRevision: 1, kind: "cross_root" as const,
    destinationRootSessionId: destination.id, destinationParentSessionId: null, destinationExpectedRevision: 1,
    transferManifestRevision: storage.getLifecycleManifest(source.id, destination.id).manifestRevision, transferPolicy: "full" as const,
    idempotencyKey: "root-move-key" };
  return { application, input, db, destinationGrant, actorId, published,
    resume: () => { publishFailure = false; }, setGeneration: (value: string) => { generation = value; },
    close: async () => { authority.close(); db.close(); storage.close(); await rm(directory, { recursive: true, force: true }); } };
}

describe("whole-root transfer public admission and replay", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "root自身のactive transfer grantで公開session.moveが成功し、同一key再送は同じ結果を返してSession revisionを再更新しない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#ownership-transfer" }
  // fault = "root selfをroot_ownerとして認可できない、または移管済みrootの同一requestを再送できず二重更新する"
  // observable = "公開resultと再送resultの一致、destination rootとsource revisionの保持"
  // observation_boundary = "public-boundary"
  // scope = "SessionExternalApplicationService session.move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("root actorの初回moveとcommitted replayを公開入口で認可する", async () => {
    const ctx = await fixture(false, false);
    try {
      const first = await ctx.application.execute("session.move", ctx.input, binding(ctx.actorId));
      assert.equal("result" in first, true, JSON.stringify(first));
      const before = ctx.db.prepare("SELECT id, resource_revision FROM sessions_v6 ORDER BY id").all();
      assert.deepEqual(await ctx.application.execute("session.move", ctx.input, binding(ctx.actorId)), first);
      assert.deepEqual(ctx.db.prepare("SELECT id, resource_revision FROM sessions_v6 ORDER BY id").all(), before);
      assert.equal(ctx.db.prepare("SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = 'source'").get()?.root_session_id, "destination");
    } finally { await ctx.close(); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "移管済みchild controllerはpublish失敗を同一principal・同一input・同一keyかつ現在有効なdestination grantでだけ再開できる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
  // fault = "移管後のsource grant失効で復旧不能になる、または別input/key/actor・失効grant・stale runtimeで復旧認可を流用できる"
  // observable = "初回applied recovery error、各不正再送のAUTHORITY_FORBIDDEN、正規再送の成功とpublish結果、DB revisionの不変"
  // observation_boundary = "public-boundary"
  // scope = "SessionExternalApplicationService committed root move recovery"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("publish失敗から復旧し、別requestと失効した復旧権限を拒否する", async () => {
    const ctx = await fixture(true, true);
    try {
      const first = await ctx.application.execute("session.move", ctx.input, binding(ctx.actorId));
      assert.equal("error" in first && first.error.code, "SESSION_LIFECYCLE_RECOVERY_REQUIRED", JSON.stringify(first));
      assert.equal("error" in first && first.error.effect, "applied");
      const before = ctx.db.prepare("SELECT id, resource_revision FROM sessions_v6 ORDER BY id").all();
      for (const [input, actor] of [[{ ...ctx.input, expectedRevision: 2 }, ctx.actorId],
        [{ ...ctx.input, idempotencyKey: "other-key" }, ctx.actorId], [ctx.input, "source"]] as const) {
        const denied = await ctx.application.execute("session.move", input, binding(actor));
        assert.equal("error" in denied && denied.error.code, "AUTHORITY_FORBIDDEN", JSON.stringify(denied));
      }
      ctx.resume();
      const recovered = await ctx.application.execute("session.move", ctx.input, binding(ctx.actorId));
      assert.equal("result" in recovered, true, JSON.stringify(recovered));
      assert.ok(ctx.published.includes("source"));
      assert.ok(ctx.published.includes("controller"));
      assert.deepEqual(ctx.db.prepare("SELECT id, resource_revision FROM sessions_v6 ORDER BY id").all(), before);
      ctx.setGeneration("generation-2");
      const stale = await ctx.application.execute("session.move", ctx.input, binding(ctx.actorId));
      assert.equal("error" in stale && stale.error.code, "AUTHORITY_FORBIDDEN", JSON.stringify(stale));
      ctx.setGeneration("generation-1");
      revokeSessionAuthorityGrant(ctx.db, { grantId: ctx.destinationGrant.grantId,
        expectedRevision: ctx.destinationGrant.revision, principal: { kind: "system", service: "test" }, revokedAt: LATER });
      const revoked = await ctx.application.execute("session.move", ctx.input, binding(ctx.actorId));
      assert.equal("error" in revoked && revoked.error.code, "AUTHORITY_FORBIDDEN", JSON.stringify(revoked));
    } finally { await ctx.close(); }
  });
});
