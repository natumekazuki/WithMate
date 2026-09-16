import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SessionAuthorityError } from "../../src/session-authority.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { issueTrustedGrantPolicy, revokeSessionAuthorityGrant } from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { buildNewSession } from "../../src/session-state.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { ResourceBudgetStorage } from "../../src-electron/resource-budget-storage.js";

const NOW = "2026-09-14T12:00:00.000Z";
const makeRoot = (id: string) => ({ ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE, rootSessionRole: "overall-coordinator" }), updatedAt: NOW });
const makeChild = (id: string, parent: ReturnType<typeof makeRoot>) => ({ ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE, roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, "executor") }), updatedAt: NOW });
const binding = (id: string, generation = "generation-1"): ResolvedAgentRuntimeBinding => ({ bindingId: `binding-${id}`, bindingIdHash: `hash-${id}`, actorSessionId: id, providerId: "codex", executionGeneration: generation, authoritySnapshot: {}, operationGrants: [], createdAt: NOW, expiresAt: null });

// @test-value v2
// kind = "security"
// claim = "grant ownerは親のactive ceilingを守り、親失効後も同一再送で初回grantを返し、他actorによる親grant取得を拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Direct validation" }
// fault = "親grantの失効後も子grantを作成する、exercise ceilingから再委譲可能なgrantを発行する、別actorが親grantを取得する"
// observable = "実SQLiteを使ったservice responseのgrant IDと初回snapshot、listのcursor/page順序・重複・revoked/grantee filter、owner拒否"
// observation_boundary = "component-behavior"
// scope = "session-grant-service-owner"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("grant service owner enforces parent ceiling and actor ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-grant-service-"));
  const dbPath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(dbPath);
  const root = makeRoot("root-a");
  const child = makeChild("child-a", root);
  storage.insertSession(root);
  storage.insertSession(child);
  const db = new DatabaseSync(dbPath);
  const authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
  try {
    const policy = issueTrustedGrantPolicy(db, { rootSessionId: root.id, granteeSessionId: root.id, actions: ["turn.run"], resourceKind: "execution", relationSelector: "root_member", targetSessionRoles: ["executor"], effectClass: "external_side_effect", delegable: true, childCeiling: [{ mode: "exercise", action: "turn.run", resourceKind: "execution", relationSelector: "self", effectClass: "external_side_effect", targetSessionRoles: ["executor"] }], expiresAt: "2026-09-15T00:00:00.000Z", principal: { kind: "system", service: "test-policy" }, proof: { principal: { kind: "system", service: "test-policy" }, operation: "turn.run", mappingRevision: 2, action: "turn.run", resolvedScope: { resourceKind: "execution", resourceId: null, rootSessionId: root.id, ownerKind: "session", ownerId: root.id, relation: "root_member" }, effectClass: "external_side_effect", grantId: null, grantRevision: null, evaluatedAt: NOW }, issuedAt: NOW });
    const parent = policy[0]!;
    const input = { parentGrantId: parent.grantId, parentGrantRevision: parent.revision, granteeSessionId: child.id, actions: ["turn.run"], resourceKind: "execution", relationSelector: "self", targetSessionRoles: ["executor"], effectClass: "external_side_effect", delegable: false, expiresAt: "2026-09-14T23:00:00.000Z", idempotencyKey: "grant-test-1" } as const;
    const created = authority.grantCreate(binding(root.id), input);
    assert.equal(created.grant.granteeSessionId, child.id);
    assert.equal(authority.grantCreate(binding(root.id), input).grant.grantId, created.grant.grantId);
    assert.equal(authority.grantGet(binding(root.id), { grantId: created.grant.grantId }).grant.grantId, created.grant.grantId);
    assert.ok(authority.grantList(binding(root.id), {}).items.some((item) => item.grant.grantId === created.grant.grantId));
    assert.throws(() => authority.grantGet(binding("child-a"), { grantId: parent.grantId }));
    assert.throws(() => authority.grantCreate(binding(root.id), { ...input, idempotencyKey: "delegable-escalation", delegable: true }));
    assert.throws(() => authority.grantCreate(binding(root.id), { ...input, idempotencyKey: "implicit-delegable-escalation", childCeiling: parent.childCeiling }));
    assert.throws(() => authority.grantCreate(binding(root.id), { ...input, idempotencyKey: "expiry-escalation", expiresAt: "2026-09-16T00:00:00.000Z" }));
    assert.throws(() => authority.grantCreate(binding(root.id), { ...input, idempotencyKey: "scope-escalation", relationSelector: "root_member" }));
    revokeSessionAuthorityGrant(db, { grantId: parent.grantId, expectedRevision: parent.revision, principal: { kind: "system", service: "test-policy" }, revokedAt: "2026-09-14T13:00:00.000Z" });
    assert.deepEqual(authority.grantCreate(binding(root.id), input).grant, created.grant);
    assert.throws(() => authority.grantCreate(binding(root.id), { ...input, expiresAt: "2026-09-14T22:00:00.000Z" }));
    assert.throws(() => authority.grantCreate(binding(root.id), { ...input, idempotencyKey: "grant-test-2" }));
    const page = authority.grantList(binding(root.id), { includeRevoked: true, limit: 1 });
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const nextPage = authority.grantList(binding(root.id), { includeRevoked: true, limit: 1, cursor: page.nextCursor });
    assert.ok(nextPage.items.length >= 1);
    assert.ok(page.items[0]!.grant.grantId < nextPage.items[0]!.grant.grantId);
    assert.equal(new Set([...page.items, ...nextPage.items].map((item) => item.grant.grantId)).size, page.items.length + nextPage.items.length);
    assert.ok(authority.grantList(binding(root.id), {}).items.every((item) => item.grant.revokedAt === null));
    assert.ok(authority.grantList(binding(root.id), { granteeSessionId: child.id }).items.every((item) => item.grant.granteeSessionId === child.id));
  } finally {
    authority.close();
    db.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "一時通信grantは指定Sessionと実予算口座に閉じ、期限切れ・失効・古いgeneration・親scope超過を拒否しつつ同一再送の初回snapshotを保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
// fault = "別rootの無関係Sessionへの通信を許可する、同一keyの別入力を採用する、失効後のadmissionを許可する"
// observable = "実SQLiteのgrant service応答、authorizeのproofと拒否、再open後のgrant revision・provenance"
// observation_boundary = "component-behavior"
// scope = "grant owner and canonical authority evaluator; Provider dispatch is excluded"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("temporary cross-root communication remains bounded through replay expiry and revoke", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-grant-consultation-"));
  const dbPath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(dbPath);
  const responder = makeRoot("responder");
  const requester = makeRoot("requester");
  const target = makeChild("target", responder);
  const other = makeChild("other", responder);
  for (const session of [responder, requester, target, other]) storage.insertSession(session);
  const db = new DatabaseSync(dbPath);
  let now = NOW;
  let authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(now) });
  try {
    const actions = ["turn.run", "turn.enqueue"] as const;
    const parent = issueTrustedGrantPolicy(db, {
      rootSessionId: responder.id, granteeSessionId: responder.id, actions, resourceKind: "execution",
      relationSelector: "root_member", targetSessionRoles: ["executor"], effectClass: "external_side_effect", delegable: true,
      childCeiling: actions.map((action) => ({ mode: "delegate", action, resourceKind: "execution", relationSelector: "root_member", effectClass: "external_side_effect", targetSessionRoles: ["executor"] })),
      resourceIds: [target.id], expiresAt: "2026-09-15T00:00:00.000Z", principal: { kind: "system", service: "test-policy" },
      proof: { principal: { kind: "system", service: "test-policy" }, operation: "turn.run", mappingRevision: 2, action: "turn.run", resolvedScope: { resourceKind: "execution", resourceId: responder.id, rootSessionId: responder.id, ownerKind: "session", ownerId: responder.id, relation: "self" }, effectClass: "external_side_effect", grantId: null, grantRevision: null, evaluatedAt: NOW }, issuedAt: NOW,
    })[0]!;
    const input = { parentGrantId: parent.grantId, parentGrantRevision: 1, granteeSessionId: requester.id,
      actions, resourceKind: "execution", relationSelector: "root_member", targetSessionRoles: ["executor"], effectClass: "external_side_effect", delegable: false,
      resourceIds: [target.id], expiresAt: "2026-09-14T13:00:00.000Z", purpose: "bounded consultation", completionCriteria: "return analysis", returnSessionId: requester.id,
      budgetAccountId: new ResourceBudgetStorage(db).get(target.id).accountId, idempotencyKey: "consultation-create" } as const;
    const created = authority.grantCreate(binding(responder.id), input);
    const admitted = authority.authorize(binding(requester.id), "turn.enqueue", { sessionId: target.id, consultationGrantId: created.grant.grantId });
    assert.equal(admitted.proof.grantId, created.grant.grantId);
    assert.equal(admitted.proof.resolvedScope.rootSessionId, responder.id);
    assert.throws(() => authority.authorize(binding(requester.id), "turn.run", { sessionId: other.id, consultationGrantId: created.grant.grantId }));
    assert.throws(() => authority.authorize(binding(requester.id, "old"), "turn.enqueue", { sessionId: target.id, consultationGrantId: created.grant.grantId }));
    assert.throws(() => authority.grantCreate(binding(responder.id), { ...input, purpose: "different" }));
    assert.throws(() => authority.grantCreate(binding(responder.id), { ...input, idempotencyKey: "wider", resourceIds: [other.id] }));
    assert.throws(() => authority.grantCreate(binding(responder.id), { ...input, idempotencyKey: "budget", budgetAccountId: requester.id }));
    assert.equal("requestJson" in created.grant.provenance, false);
    now = "2026-09-14T13:00:00.000Z";
    assert.throws(() => authority.authorize(binding(requester.id), "turn.enqueue", { sessionId: target.id, consultationGrantId: created.grant.grantId }));
    now = "2026-09-15T00:00:00.000Z";
    assert.deepEqual(authority.grantCreate(binding(responder.id), input).grant, created.grant);
    assert.throws(() => authority.grantCreate(binding(responder.id), { ...input, idempotencyKey: "expired-parent" }));
    assert.throws(() => authority.grantCreate(binding(responder.id), { ...input, purpose: "changed after expiry" }));
    now = "2026-09-14T13:00:00.000Z";
    const revoke = { grantId: created.grant.grantId, expectedRevision: 1, idempotencyKey: "revoke" };
    assert.equal(authority.grantRevoke(binding(responder.id), revoke).grant.revision, 2);
    assert.equal(authority.grantRevoke(binding(responder.id), revoke).grant.revision, 2);
    const event = db.prepare("SELECT principal_kind, actor_session_id FROM session_authority_grant_events_v6 WHERE grant_id = ? AND event_kind = 'revoked'").get(created.grant.grantId);
    assert.deepEqual({ ...event }, { principal_kind: "agent", actor_session_id: responder.id });
    authority.close();
    authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(now) });
    const persisted = authority.grantGet(binding(requester.id), { grantId: created.grant.grantId }).grant;
    assert.equal(persisted.provenance.purpose, "bounded consultation");
    assert.equal(persisted.revision, 2);
  } finally {
    authority.close(); db.close(); storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "same-rootの非parent Sessionはactiveなexplicit grantのresource scopeでroutingでき、grant unionとrevokeを正しく評価し、trusted policyの不正な発行日時を拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Same-root routing" }
// fault = "parent matrixがないtargetを拒否する、または一方のgrant revokeで別の有効grantまで無効化する、または不正日時のpolicyを保存する"
// observable = "実SQLiteを使ったauthorize proofのgrantIdと許可・拒否結果、trusted policyの不正resource/account拒否、不正issuedAtのAUTHORITY_SCOPE_INVALID"
// observation_boundary = "component-behavior"
// scope = "same-root grant routing evaluator"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("same-root non-parent routing uses explicit grant union", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-grant-routing-"));
  const dbPath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(dbPath);
  const root = makeRoot("root-routing");
  const parent = makeChild("parent-routing", root);
  const sibling = makeChild("sibling-routing", root);
  storage.insertSession(root); storage.insertSession(parent); storage.insertSession(sibling);
  const db = new DatabaseSync(dbPath);
  const authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
  try {
    const common = { rootSessionId: root.id, granteeSessionId: parent.id, actions: ["turn.enqueue"] as const, resourceKind: "execution" as const, relationSelector: "root_member" as const, targetSessionRoles: ["executor"] as const, effectClass: "external_side_effect" as const, delegable: false, childCeiling: [] as const, resourceIds: [sibling.id] as const, expiresAt: "2026-09-15T00:00:00.000Z", principal: { kind: "system" as const, service: "routing-test" }, proof: { principal: { kind: "system" as const, service: "routing-test" }, operation: "turn.enqueue" as const, mappingRevision: 2, action: "turn.enqueue" as const, resolvedScope: { resourceKind: "execution" as const, resourceId: sibling.id, rootSessionId: root.id, ownerKind: "session" as const, ownerId: root.id, relation: "self" as const }, effectClass: "external_side_effect" as const, grantId: null, grantRevision: null, evaluatedAt: NOW }, issuedAt: NOW };
    assert.throws(() => authority.authorize(binding(parent.id), "turn.enqueue", { sessionId: sibling.id }));
    assert.throws(() => issueTrustedGrantPolicy(db, { ...common, resourceIds: ["missing-session"] }), /resource/i);
    assert.throws(() => issueTrustedGrantPolicy(db, { ...common, budgetAccountId: "wrong-account" }), /account/i);
    assert.throws(() => issueTrustedGrantPolicy(db, { ...common, issuedAt: "invalid-date" }), (error: unknown) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_SCOPE_INVALID");
    const first = issueTrustedGrantPolicy(db, { ...common })[0]!;
    const second = issueTrustedGrantPolicy(db, { ...common, resourceIds: [sibling.id], proof: common.proof })[0]!;
    const input = { sessionId: sibling.id };
    const admitted = authority.authorize(binding(parent.id), "turn.enqueue", input);
    assert.ok([first.grantId, second.grantId].includes(admitted.proof.grantId));
    revokeSessionAuthorityGrant(db, { grantId: first.grantId, expectedRevision: first.revision, principal: { kind: "system", service: "routing-test" }, revokedAt: "2026-09-14T12:30:00.000Z" });
    assert.equal(authority.authorize(binding(parent.id), "turn.enqueue", input).proof.grantId, second.grantId);
    assert.throws(() => authority.authorize(binding(parent.id), "turn.run", input));
  } finally { authority.close(); db.close(); storage.close(); await rm(directory, { recursive: true, force: true }); }
});
