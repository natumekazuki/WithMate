import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";

import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  SessionAuthorityError,
  type MutationAuthorityProof,
  type ResourceEventHeader,
  type SessionAuthorityGrant,
  type SessionAuthorityConstructionCeiling,
  type SessionAuthorityPermission,
  type SessionAuthorityRootConstructionInput,
  type SessionAuthorityPrincipal,
  type SessionAuthorityRelationSelector,
  type SessionAuthorityResourceKind,
} from "../src/session-authority.js";
import { SESSION_RUNTIME_OPERATIONS, type SessionRuntimeOperation } from "../src/session-external-runtime-contract.js";
import { SESSION_ROLE_VALUES, type SessionRole } from "../src/session-role-binding.js";
import { ensureSessionAuthoritySchema } from "./session-authority-schema.js";
import { RESOURCE_BUDGET_DIMENSIONS } from "../src/resource-budget.js";
import type {
  SessionGrantCreateInput,
  SessionGrantGetInput,
  SessionGrantListInput,
  SessionGrantRevokeInput,
} from "../src/session-grant.js";

type RoleBindingRow = {
  session_role: SessionRole;
  root_session_id: string;
  parent_session_id: string | null;
};

type GrantRow = {
  grant_id: string;
  root_session_id: string;
  issuer_kind: SessionAuthorityPrincipal["kind"];
  issuer_id: string;
  issuer_grant_id: string | null;
  issuer_grant_revision: number | null;
  grantee_session_id: string;
  actions_json: string;
  resource_kind: SessionAuthorityResourceKind;
  relation_selector: SessionAuthorityRelationSelector;
  target_session_roles_json: string;
  effect_class: SessionAuthorityGrant["effectClass"];
  delegable: number;
  child_ceiling_json: string;
  issued_at: string;
  effective_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revision: number;
  mapping_revision: number;
  provenance_json: string;
};

const ALL_ROLES = [...SESSION_ROLE_VALUES];

function permission(
  action: SessionRuntimeOperation,
  relationSelector: SessionAuthorityRelationSelector,
  targetSessionRoles: readonly SessionRole[] = ALL_ROLES,
  delegable = false,
): SessionAuthorityPermission {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[action];
  return {
    mode: delegable ? "delegate" : "exercise",
    action,
    resourceKind: definition.resourceKind,
    relationSelector,
    effectClass: definition.effectClass,
    targetSessionRoles,
  };
}

function ownBaselinePermissions(role: SessionRole): SessionAuthorityPermission[] {
  const own = [
    permission("runtime.catalog", "self"),
    permission("session.self", "self"),
    permission("session.list", "self"),
    permission("session.get", "self"),
    permission("session.rename", "self"),
    permission("session.files.list", "self"),
    permission("session.files.read_text", "self"),
    permission("session.files.write_text", "self"),
    permission("turn.options", "self"),
    permission("turn.run", "self"),
    permission("turn.enqueue", "self"),
    permission("turn.list", "self"),
    permission("turn.get", "created"),
    permission("turn.cancel", "created"),
    permission("interaction.list", "self"),
    permission("interaction.respond", "created"),
    permission("coordination.event.create", "self"),
    permission("coordination.event.list", "self"),
    permission("coordination.event.get", "created"),
    permission("coordination.event.resolve", "created"),
    permission("coordination.event.consume", "created"),
    permission("coordination.event.cancel", "created"),
    permission("coordination.event.correct", "created"),
    permission("transcript.export", "self"),
    permission("work.list", "creator_or_target"),
    permission("work.get", "assigned"),
    permission("work.get", "created"),
    permission("work.transition", "assigned"),
    permission("work.result", "assigned"),
    permission("work.cancel", "created"),
    permission("work.aggregation.get", "assigned"),
    permission("work.aggregation.list", "assigned"),
  ];
  if (role === "standalone" || role === "overall-coordinator") {
    own.push(
      permission("work.revise", "owned_root"),
      permission("work.history.append", "owned_root"),
      permission("work.history.list", "owned_root"),
    );
  }
  if (role === "overall-coordinator" || role === "task-coordinator") {
    own.push(
      permission("work.aggregation.decide", "assigned"),
      permission("work.aggregation.retry", "assigned"),
    );
  }
  return own;
}

export function baselineSessionAuthorityPermissions(role: SessionRole): SessionAuthorityPermission[] {
  const values = ownBaselinePermissions(role);
  if (role === "overall-coordinator") {
    values.push(
      permission("session.create", "self", ["task-coordinator", "executor"], true),
      permission("session.list", "root_member"),
      permission("session.get", "root_member"),
      permission("session.files.list", "root_member"),
      permission("session.files.read_text", "root_member"),
      permission("turn.options", "direct_child", ["task-coordinator", "executor"], true),
      permission("turn.run", "direct_child", ["task-coordinator", "executor"], true),
      permission("turn.enqueue", "direct_child", ["task-coordinator", "executor"], true),
      permission("turn.list", "direct_child", ["task-coordinator", "executor"], true),
      permission("work.create", "direct_child", ["task-coordinator", "executor"], true),
      permission("work.list", "root_member"),
      permission("work.get", "root_member"),
      permission("coordination.event.list", "root_member"),
      permission("coordination.event.get", "root_member"),
      permission("coordination.event.resolve", "root_member"),
    );
  } else if (role === "task-coordinator") {
    values.push(
      permission("session.create", "self", ["executor"], true),
      permission("session.get", "parent", ["overall-coordinator"]),
      permission("session.get", "direct_child", ["executor"], true),
      permission("session.get", "sibling", ["task-coordinator"]),
      permission("turn.options", "parent", ["overall-coordinator"]),
      permission("turn.run", "parent", ["overall-coordinator"]),
      permission("turn.enqueue", "parent", ["overall-coordinator"]),
      permission("turn.list", "parent", ["overall-coordinator"]),
      permission("turn.options", "direct_child", ["executor"], true),
      permission("turn.run", "direct_child", ["executor"], true),
      permission("turn.enqueue", "direct_child", ["executor"], true),
      permission("turn.list", "direct_child", ["executor"], true),
      permission("turn.options", "sibling", ["task-coordinator"]),
      permission("turn.run", "sibling", ["task-coordinator"]),
      permission("turn.enqueue", "sibling", ["task-coordinator"]),
      permission("turn.list", "sibling", ["task-coordinator"]),
      permission("work.create", "direct_child", ["executor"], true),
      permission("coordination.event.list", "direct_child", ["executor"]),
      permission("coordination.event.get", "direct_child", ["executor"]),
      permission("coordination.event.resolve", "direct_child", ["executor"]),
    );
  } else if (role === "executor") {
    values.push(
      permission("session.get", "parent", ["overall-coordinator", "task-coordinator"]),
      permission("turn.options", "parent", ["overall-coordinator", "task-coordinator"]),
      permission("turn.run", "parent", ["overall-coordinator", "task-coordinator"]),
      permission("turn.enqueue", "parent", ["overall-coordinator", "task-coordinator"]),
      permission("turn.list", "parent", ["overall-coordinator", "task-coordinator"]),
    );
  }
  return values;
}

function childCeilingFor(role: SessionRole, action: SessionRuntimeOperation): SessionAuthorityPermission[] {
  if (action !== "session.create") return [];
  const childRoles = role === "overall-coordinator"
    ? (["task-coordinator", "executor"] as const)
    : role === "task-coordinator"
      ? (["executor"] as const)
      : [];
  return childRoles.flatMap((childRole) => baselineSessionAuthorityPermissions(childRole));
}

export function syncSessionAuthorityOperationRegistry(db: DatabaseSync): void {
  ensureSessionAuthoritySchema(db);
  const insert = db.prepare(`
    INSERT INTO session_authority_operation_registry_v6 (
      operation, mapping_revision, action, resource_kind, scope_source, effect_class, decision_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(operation) DO UPDATE SET
      mapping_revision = excluded.mapping_revision,
      action = excluded.action,
      resource_kind = excluded.resource_kind,
      scope_source = excluded.scope_source,
      effect_class = excluded.effect_class,
      decision_class = excluded.decision_class
  `);
  for (const operation of SESSION_RUNTIME_OPERATIONS) {
    const item = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
    insert.run(operation, SESSION_AUTHORITY_MAPPING_REVISION, item.action, item.resourceKind, item.scopeSource, item.effectClass, item.decisionClass);
  }
  const placeholders = SESSION_RUNTIME_OPERATIONS.map(() => "?").join(", ");
  db.prepare(`DELETE FROM session_authority_operation_registry_v6 WHERE operation NOT IN (${placeholders})`)
    .run(...SESSION_RUNTIME_OPERATIONS);
}

export function ensureBaselineSessionAuthority(db: DatabaseSync, sessionId: string, issuedAt: string): void {
  ensureSessionAuthoritySchema(db);
  const binding = requireRoleBinding(db, sessionId);
  const existing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM session_authority_grants_v6
    WHERE grantee_session_id = ?
      AND mapping_revision = ?
  `).get(sessionId, SESSION_AUTHORITY_MAPPING_REVISION) as { count: number };
  if (existing.count > 0) return;
  for (const item of baselineSessionAuthorityPermissions(binding.session_role)) {
    insertGrant(db, {
      rootSessionId: binding.root_session_id,
      issuerKind: "system",
      issuerId: "session-authority-baseline-migration",
      issuerGrantId: null,
      issuerGrantRevision: null,
      granteeSessionId: sessionId,
      permission: item,
      childCeiling: childCeilingFor(binding.session_role, item.action),
      issuedAt,
      expiresAt: null,
      eventKind: "baseline_issued",
      eventPrincipalKind: "system",
      eventActorSessionId: null,
      provenance: {
        source: "role-baseline",
        sessionRole: binding.session_role,
        mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
      },
    });
  }
  ensureBudgetSessionAuthority(db, sessionId, issuedAt);
}

const BUDGET_AUTHORITY_MIGRATION_KEY = "resource_budget_authority_v1_migrated_at";
const BUDGET_ACTIONS = ["budget.get", "budget.list", "budget.configure"] as const;

export function ensureBudgetSessionAuthority(db: DatabaseSync, sessionId: string, issuedAt: string): void {
  const rows = db.prepare("SELECT * FROM session_authority_grants_v6 WHERE grantee_session_id = ?")
    .all(sessionId) as GrantRow[];
  if (rows.some((row) => grantProvenanceSource(row) === "resource-budget-v1")) return;
  const source = rows.find((row) => JSON.parse(row.actions_json).includes("session.self"));
  if (!source) throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "Budget authority requires existing Session authority.");
  for (const action of BUDGET_ACTIONS) {
    insertGrant(db, {
      rootSessionId: source.root_session_id,
      issuerKind: "system",
      issuerId: "resource-budget-v1-migration",
      issuerGrantId: source.grant_id,
      issuerGrantRevision: 1,
      granteeSessionId: sessionId,
      permission: permission(action, "self"),
      childCeiling: [],
      issuedAt,
      expiresAt: source.expires_at,
      eventKind: "baseline_issued",
      eventPrincipalKind: "system",
      eventActorSessionId: null,
      provenance: { source: "resource-budget-v1", sourceGrantId: source.grant_id, policy: "user-approved-2026-09-07" },
    });
  }
}

export function backfillBaselineSessionAuthority(db: DatabaseSync, issuedAt: string): void {
  ensureSessionAuthoritySchema(db);
  syncSessionAuthorityOperationRegistry(db);
  const rows = db.prepare(`
    SELECT binding.session_id
    FROM session_role_bindings_v6 AS binding
    INNER JOIN sessions_v6 AS session ON session.id = binding.session_id
    WHERE session.deleted_at IS NULL
    ORDER BY delegation_depth, session_id
  `).all() as Array<{ session_id: string }>;
  for (const row of rows) ensureBaselineSessionAuthority(db, row.session_id, issuedAt);
  const migrated = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?")
    .get(BUDGET_AUTHORITY_MIGRATION_KEY);
  if (!migrated) {
    for (const row of rows) ensureBudgetSessionAuthority(db, row.session_id, issuedAt);
    if (rows.length > 0) db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)")
      .run(BUDGET_AUTHORITY_MIGRATION_KEY, issuedAt, issuedAt);
  }
  verifySessionAuthorityMigration(db);
}

export function createDelegatedChildAuthority(db: DatabaseSync, input: {
  parentProof: MutationAuthorityProof;
  childSessionId: string;
  operationId: string;
  createdAt: string;
  requestedActions?: readonly string[];
  requestedExpiresAt?: string | null;
}): void {
  assertGrantProofCurrent(db, input.parentProof, new Date(input.createdAt));
  if (
    input.parentProof.principal.kind !== "agent"
    || input.parentProof.operation !== "session.create"
    || input.parentProof.grantId === null
  ) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Child authority requires an admitted Session create operation.");
  }
  const parentGrant = requireGrant(db, input.parentProof.grantId);
  const childBinding = requireRoleBinding(db, input.childSessionId);
  if (childBinding.parent_session_id !== input.parentProof.principal.actorSessionId) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "Child Session does not belong to the admitted parent.");
  }
  const template = baselineSessionAuthorityPermissions(childBinding.session_role);
  const requestedActions = input.requestedActions ? new Set(input.requestedActions) : null;
  for (const item of template) {
    if (requestedActions && !requestedActions.has(item.action)) continue;
    const ceiling = parentGrant.childCeiling.find((candidate) => samePermission(candidate, item));
    if (!ceiling) continue;
    insertGrant(db, {
      rootSessionId: childBinding.root_session_id,
      issuerKind: "agent",
      issuerId: input.parentProof.principal.actorSessionId,
      issuerGrantId: parentGrant.grantId,
      issuerGrantRevision: parentGrant.revision,
      granteeSessionId: input.childSessionId,
      permission: item,
      childCeiling: childCeilingFor(childBinding.session_role, item.action),
      issuedAt: input.createdAt,
      expiresAt: earlierExpiry(parentGrant.expiresAt, input.requestedExpiresAt ?? null),
      eventKind: "delegated",
      eventPrincipalKind: "agent",
      eventActorSessionId: input.parentProof.principal.actorSessionId,
      provenance: {
        source: "child-construction",
        operationId: input.operationId,
        parentGrantId: parentGrant.grantId,
        parentGrantRevision: parentGrant.revision,
        mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
      },
    });
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?")
    .get(input.childSessionId) as { count: number };
  if (count.count === 0) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The parent construction grant does not provide a child authority ceiling.");
  }
  ensureBudgetSessionAuthority(db, input.childSessionId, input.createdAt);
}

/** Canonical owner for the public grant.create operation. */
export function createSessionAuthorityGrant(db: DatabaseSync, input: {
  issuerSessionId: string;
  parentProof?: MutationAuthorityProof;
  grant: SessionGrantCreateInput;
  issuedAt: string;
}): SessionAuthorityGrant {
  const { grant } = input;
  if (grant.idempotencyKey.trim() === "") {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "Grant creation requires an idempotency key.");
  }
  const requestJson = JSON.stringify(grant);
  const replayRows = db.prepare("SELECT * FROM session_authority_grants_v6 WHERE issuer_kind = 'agent' AND issuer_id = ? AND json_extract(provenance_json, '$.idempotencyKey') = ? ORDER BY revision DESC").all(input.issuerSessionId, grant.idempotencyKey) as GrantRow[];
  const replay = replayRows.map(decodeGrant).find((candidate) => candidate.provenance.source === "agent-grant");
  if (replay) {
    if (typeof replay.provenance.requestJson !== "string" || !isDeepStrictEqual(JSON.parse(replay.provenance.requestJson), grant)) {
      throw new SessionAuthorityError("AUTHORITY_GRANT_REVISION_CONFLICT", "The idempotency key was used with different grant input.", { grantId: replay.grantId });
    }
    const event = db.prepare("SELECT payload_json FROM session_authority_grant_events_v6 WHERE grant_id = ? AND grant_revision = 1 ORDER BY sequence LIMIT 1").get(replay.grantId) as { payload_json: string };
    return { ...replay, revision: 1, revokedAt: null, provenance: JSON.parse(event.payload_json) };
  }
  const parent = requireGrant(db, grant.parentGrantId);
  if (input.parentProof) {
    if (input.parentProof.principal.kind !== "agent" || input.parentProof.principal.actorSessionId !== input.issuerSessionId
      || input.parentProof.grantId !== grant.parentGrantId || input.parentProof.grantRevision !== grant.parentGrantRevision) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Grant creation requires the admitted parent grant.");
    }
    assertGrantProofCurrent(db, input.parentProof, new Date(input.issuedAt));
  }
  assertGrantActive(parent, input.issuerSessionId, grant.parentGrantRevision, new Date(input.issuedAt));
  assertIssuerChainCurrent(db, parent, new Date(input.issuedAt));
  if (!parent.delegable || parent.granteeSessionId !== input.issuerSessionId) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The parent grant is not delegable by this issuer.");
  }
  const child = requireRoleBinding(db, grant.granteeSessionId);
  const issuer = requireRoleBinding(db, input.issuerSessionId);
  assertSessionMutationNotDraining(db, [issuer.root_session_id, parent.rootSessionId, child.root_session_id]);
  if (issuer.root_session_id !== parent.rootSessionId && !Array.isArray(parent.provenance.resourceIds)) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The issuer is outside the parent root.");
  }
  const crossRoot = child.root_session_id !== parent.rootSessionId;
  if (crossRoot && (grant.resourceIds === undefined || grant.resourceIds.length === 0 || grant.expiresAt === null
    || grant.purpose === undefined || grant.completionCriteria === undefined || grant.returnSessionId === undefined || grant.budgetAccountId === undefined)) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "Cross-root grants require exact resources, expiry, purpose, completion criteria, and return destination.");
  }
  if (grant.actions.length === 0 || new Set(grant.actions).size !== grant.actions.length) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "A grant must contain unique actions.");
  }
  const ceiling = parent.childCeiling;
  if (parent.provenance.source !== "role-baseline" && parent.provenance.source !== "child-construction"
    && grant.actions.some((action) => !parent.actions.includes(action))) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Delegation cannot add actions to the issuer grant.");
  }
  if (parent.provenance.source !== "role-baseline" && parent.provenance.source !== "child-construction"
    && (parent.resourceKind !== grant.resourceKind || parent.effectClass !== grant.effectClass
      || !relationCanNarrow(parent.relationSelector, grant.relationSelector)
      || !grant.targetSessionRoles.every((role) => parent.targetSessionRoles.includes(role)))) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Delegation cannot widen the issuer resource scope.");
  }
  if (input.issuerSessionId !== grant.granteeSessionId
    && !["root_member", "visible_root"].includes(parent.relationSelector)) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Relative grants cannot be rebound to a different grantee; issue an explicit root policy first.");
  }
  for (const action of grant.actions) {
    const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[action];
    if (!definition) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant contains an unknown operation.", { action });
    if (!ceiling.some((item) => item.action === action
      && (!grant.delegable || item.mode === "delegate")
      && item.resourceKind === grant.resourceKind
      && item.effectClass === grant.effectClass
      && relationCanNarrow(item.relationSelector, grant.relationSelector)
      && grant.targetSessionRoles.every((role) => item.targetSessionRoles.includes(role)))) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The delegated grant exceeds its parent ceiling.", { action });
    }
    if (definition.resourceKind !== grant.resourceKind || definition.effectClass !== grant.effectClass) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant scope does not match the operation definition.", { action });
    }
  }
  const issuedMs = Date.parse(input.issuedAt);
  const requestedExpiry = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);
  if (!Number.isFinite(issuedMs) || (requestedExpiry !== null && (!Number.isFinite(requestedExpiry) || requestedExpiry <= issuedMs))) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant timestamps are invalid.");
  }
  if (parent.expiresAt !== null && (requestedExpiry === null || requestedExpiry > Date.parse(parent.expiresAt))) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The delegated grant cannot outlive its parent.");
  }
  const childCeiling = grant.childCeiling ?? [];
  if (!grant.delegable && childCeiling.length > 0) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "A non-delegable grant cannot carry a child ceiling.");
  }
  for (const item of childCeiling) {
    if (!grant.actions.includes(item.action) || item.resourceKind !== grant.resourceKind || item.effectClass !== grant.effectClass
      || !relationCanNarrow(grant.relationSelector, item.relationSelector)
      || !item.targetSessionRoles.every((role) => grant.targetSessionRoles.includes(role))
      || !ceiling.some((candidate) => samePermission(candidate, item) && (item.mode !== "delegate" || candidate.mode === "delegate"))) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The child ceiling exceeds its parent ceiling.");
    }
  }
  validateGrantBudget(grant.budget, parent);
  const parentResourceIds = parent.provenance.resourceIds;
  if (parent.provenance.budgetAccountId !== undefined && parent.provenance.budgetAccountId !== grant.budgetAccountId) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Delegation cannot change the budget account.");
  if (parentResourceIds !== undefined) {
    if (!Array.isArray(parentResourceIds) || grant.resourceIds === undefined
      || grant.resourceIds.some((resourceId) => !parentResourceIds.includes(resourceId))) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The resource scope exceeds its parent scope.");
    }
  }
  const provenance: Record<string, unknown> = { source: "agent-grant", parentGrantId: parent.grantId, parentGrantRevision: parent.revision, idempotencyKey: grant.idempotencyKey, requestJson };
  if (grant.budget !== undefined) provenance.budget = grant.budget;
  if (grant.resourceIds !== undefined) {
    if (grant.resourceIds.length === 0 || new Set(grant.resourceIds).size !== grant.resourceIds.length) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The resource scope must contain unique resource IDs.");
    }
    provenance.resourceIds = [...grant.resourceIds];
  }
  if (grant.purpose !== undefined) provenance.purpose = grant.purpose;
  if (grant.completionCriteria !== undefined) provenance.completionCriteria = grant.completionCriteria;
  if (grant.returnSessionId !== undefined) provenance.returnSessionId = grant.returnSessionId;
  if (grant.budgetAccountId !== undefined) provenance.budgetAccountId = grant.budgetAccountId;
  if (grant.returnSessionId !== undefined) {
    const destination = requireRoleBinding(db, grant.returnSessionId);
    if (destination.root_session_id !== child.root_session_id) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The return destination must belong to the requester root.");
  }
  const resourceOwners = grant.resourceIds?.map((id) => requireGrantResourceOwner(db, grant.resourceKind, id, parent.rootSessionId, grant.actions));
  for (const owner of resourceOwners ?? [parent.rootSessionId]) {
    assertGrantBudgetAccount(db, { rootSessionId: parent.rootSessionId, provenance }, owner);
  }
  const createdGrantId = insertGrant(db, {
    rootSessionId: parent.rootSessionId,
    issuerKind: "agent", issuerId: input.issuerSessionId,
    issuerGrantId: parent.grantId, issuerGrantRevision: parent.revision,
    granteeSessionId: grant.granteeSessionId, actions: grant.actions,
    permission: { mode: grant.delegable ? "delegate" : "exercise", action: grant.actions[0]!, resourceKind: grant.resourceKind, relationSelector: grant.relationSelector, effectClass: grant.effectClass, targetSessionRoles: grant.targetSessionRoles },
    childCeiling, issuedAt: input.issuedAt, expiresAt: grant.expiresAt,
    eventKind: "delegated", eventPrincipalKind: "agent", eventActorSessionId: input.issuerSessionId, provenance,
  });
  const created = requireGrant(db, createdGrantId);
  if (!created) throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The delegated grant was not persisted.");
  return created;
}

/** Trusted policy path for explicitly provisioning a grant to a root/session. */
export function issueTrustedGrantPolicy(db: DatabaseSync, input: {
  rootSessionId: string;
  granteeSessionId: string;
  actions: readonly SessionRuntimeOperation[];
  resourceKind: SessionAuthorityResourceKind;
  relationSelector: SessionAuthorityRelationSelector;
  targetSessionRoles: readonly SessionRole[];
  effectClass: SessionAuthorityGrant["effectClass"];
  delegable: boolean;
  childCeiling: readonly SessionAuthorityPermission[];
  resourceIds?: readonly string[];
  budgetAccountId?: string;
  budget?: Readonly<Record<string, number>>;
  expiresAt: string | null;
  principal: Extract<SessionAuthorityPrincipal, { kind: "user" | "system" }>;
  proof: MutationAuthorityProof;
  issuedAt: string;
}): readonly SessionAuthorityGrant[] {
  const trusted = input.principal;
  const proofPrincipal = input.proof.principal;
  const matching = trusted.kind === "user"
    ? proofPrincipal.kind === "user" && proofPrincipal.receiptId === trusted.receiptId
    : proofPrincipal.kind === "system" && proofPrincipal.service === trusted.service;
  if (!matching) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Trusted grant policy requires matching authority.");
  }
  const root = requireRoleBinding(db, input.rootSessionId);
  const grantee = requireRoleBinding(db, input.granteeSessionId);
  if (root.root_session_id !== input.rootSessionId || grantee.root_session_id !== input.rootSessionId) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The trusted grant policy is outside the root scope.");
  }
  const seen = new Set<string>();
  for (const action of input.actions) {
    if (seen.has(action)) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The trusted grant policy contains duplicate actions.");
    seen.add(action);
    const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[action];
    if (!definition || definition.resourceKind !== input.resourceKind || definition.effectClass !== input.effectClass) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The trusted grant policy does not match operation definitions.");
    }
  }
  if (!Number.isFinite(Date.parse(input.issuedAt)) || input.actions.length === 0 || (input.expiresAt !== null && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)))) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant policy actions or timestamps are invalid.");
  if (!input.delegable && input.childCeiling.length > 0) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "A non-delegable policy cannot carry a child ceiling.");
  for (const item of input.childCeiling) {
    if (!input.actions.includes(item.action) || item.resourceKind !== input.resourceKind || item.effectClass !== input.effectClass
      || !relationCanNarrow(input.relationSelector, item.relationSelector)
      || !item.targetSessionRoles.every((role) => input.targetSessionRoles.includes(role))) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The policy child ceiling exceeds its own scope.");
    }
  }
  if (input.resourceIds && (input.resourceIds.length === 0 || new Set(input.resourceIds).size !== input.resourceIds.length)) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The policy resources must be unique and nonempty.");
  }
  validateGrantBudget(input.budget, { provenance: {} });
  const provenance = { source: "trusted-grant-policy", resourceIds: input.resourceIds, budgetAccountId: input.budgetAccountId, budget: input.budget, policyRootSessionId: input.rootSessionId };
  const resourceOwners = input.resourceIds?.map((id) => requireGrantResourceOwner(db, input.resourceKind, id, input.rootSessionId, input.actions));
  for (const owner of resourceOwners ?? [input.rootSessionId]) assertGrantBudgetAccount(db, { rootSessionId: input.rootSessionId, provenance }, owner);
  const id = insertGrant(db, {
    rootSessionId: input.rootSessionId, issuerKind: trusted.kind,
    issuerId: trusted.kind === "user" ? trusted.receiptId : trusted.service,
    issuerGrantId: null, issuerGrantRevision: null, granteeSessionId: input.granteeSessionId,
    actions: input.actions,
    permission: { mode: input.delegable ? "delegate" : "exercise", action: input.actions[0]!, resourceKind: input.resourceKind, relationSelector: input.relationSelector, effectClass: input.effectClass, targetSessionRoles: input.targetSessionRoles },
    childCeiling: input.childCeiling, issuedAt: input.issuedAt, expiresAt: input.expiresAt,
    eventKind: "delegated", eventPrincipalKind: trusted.kind, eventActorSessionId: null,
    provenance,
  });
  return [requireGrant(db, id)];
}

export function getSessionAuthorityGrant(db: DatabaseSync, issuerSessionId: string, input: SessionGrantGetInput): SessionAuthorityGrant {
  const grant = requireGrant(db, input.grantId);
  if (grant.granteeSessionId !== issuerSessionId && !(grant.issuerKind === "agent" && grant.issuerId === issuerSessionId)) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The grant is outside the actor scope.");
  return grant;
}

export function listSessionAuthorityGrants(db: DatabaseSync, issuerSessionId: string, input: SessionGrantListInput = {}): SessionAuthorityGrant[] {
  const limit = input.limit ?? 50;
  const clauses = ["(grantee_session_id = ? OR (issuer_kind = 'agent' AND issuer_id = ?))"];
  const params: Array<string | number> = [issuerSessionId, issuerSessionId];
  if (input.granteeSessionId !== undefined) {
    clauses.push("grantee_session_id = ?");
    params.push(input.granteeSessionId);
  }
  if (input.includeRevoked !== true) clauses.push("revoked_at IS NULL");
  if (input.cursor !== undefined) {
    clauses.push("grant_id > ?");
    params.push(input.cursor);
  }
  params.push(limit + 1);
  const rows = db.prepare(`SELECT * FROM session_authority_grants_v6 WHERE ${clauses.join(" AND ")} ORDER BY grant_id LIMIT ?`).all(...params) as GrantRow[];
  return rows.map(decodeGrant);
}

export function revokeSessionAuthorityGrantByActor(db: DatabaseSync, issuerSessionId: string, input: SessionGrantRevokeInput, revokedAt: string): SessionAuthorityGrant {
  const grant = requireGrant(db, input.grantId);
  if (!(grant.issuerKind === "agent" && grant.issuerId === issuerSessionId) && grant.granteeSessionId !== issuerSessionId) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The actor cannot revoke this grant.");
  const replay = db.prepare("SELECT grant_id, payload_json FROM session_authority_grant_events_v6 WHERE event_kind = 'revoked' AND actor_session_id = ? AND json_extract(payload_json, '$.idempotencyKey') = ?").get(issuerSessionId, input.idempotencyKey) as { grant_id: string; payload_json: string } | undefined;
  if (replay) {
    if (!isDeepStrictEqual(JSON.parse(replay.payload_json).request, input)) throw new SessionAuthorityError("AUTHORITY_GRANT_REVISION_CONFLICT", "The revoke key belongs to another request.");
    return requireGrant(db, replay.grant_id);
  }
  if (grant.revokedAt !== null) throw new SessionAuthorityError("AUTHORITY_GRANT_REVOKED", "The grant is already revoked; retrieve its current state.");
  return revokeSessionAuthorityGrant(db, { grantId: input.grantId, expectedRevision: input.expectedRevision, principal: { kind: "agent", agent: "session-runtime", actorSessionId: issuerSessionId, runtimeGeneration: "grant-owner" }, revokedAt, payload: { idempotencyKey: input.idempotencyKey, request: input } });
}

/** Trusted Settings/lifecycle owner only. This is intentionally not an Agent grant API. */
export function issueRootConstructionCapability(db: DatabaseSync, input: {
  rootSessionId: string;
  granteeSessionId: string;
  targetSessionRoles: readonly SessionRole[];
  ceiling: SessionAuthorityConstructionCeiling;
  principal: Extract<SessionAuthorityPrincipal, { kind: "user" | "system" }>;
  proof: MutationAuthorityProof;
  issuedAt: string;
}): SessionAuthorityGrant {
  const trustedPrincipal = input.principal;
  const proofPrincipal = input.proof.principal;
  const matchingTrustedProof = trustedPrincipal.kind === "user"
    ? proofPrincipal.kind === "user" && proofPrincipal.receiptId === trustedPrincipal.receiptId
    : proofPrincipal.kind === "system" && proofPrincipal.service === trustedPrincipal.service;
  if (!matchingTrustedProof) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Root construction capability requires matching trusted authority.");
  }
  const binding = requireRoleBinding(db, input.granteeSessionId);
  if (binding.root_session_id !== input.rootSessionId
    || binding.root_session_id !== input.granteeSessionId
    || binding.parent_session_id !== null) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "A construction capability must be issued to a root Session.");
  }
  const transferPermission = {
    mode: "delegate" as const,
    action: "session.create" as const,
    resourceKind: "session_namespace" as const,
    relationSelector: "self" as const,
    effectClass: "local_mutation" as const,
    targetSessionRoles: input.targetSessionRoles,
  };
  const grantIdBefore = new Set(listActiveSessionAuthorityGrants(db, input.granteeSessionId, new Date(input.issuedAt)).map((grant) => grant.grantId));
  insertGrant(db, {
    rootSessionId: input.rootSessionId,
    issuerKind: input.principal.kind,
    issuerId: input.principal.kind === "user" ? input.principal.receiptId : input.principal.service,
    issuerGrantId: null,
    issuerGrantRevision: null,
    granteeSessionId: input.granteeSessionId,
    permission: transferPermission,
    childCeiling: input.ceiling.actions,
    issuedAt: input.issuedAt,
    expiresAt: input.ceiling.expiresAt,
    eventKind: "delegated",
    eventPrincipalKind: input.principal.kind,
    eventActorSessionId: null,
    provenance: { source: "trusted-root-construction", constructionCeiling: input.ceiling },
  });
  const created = listActiveSessionAuthorityGrants(db, input.granteeSessionId, new Date(input.issuedAt))
    .find((grant) => !grantIdBefore.has(grant.grantId) && grant.actions.includes("session.create"));
  if (!created) throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The construction capability was not persisted.");
  return created;
}

/** Trusted internal provisioning for a cross-root transfer scope. */
export function issueTrustedCrossRootTransferCapability(db: DatabaseSync, input: {
  sourceActorSessionId: string;
  destinationRootSessionId: string;
  destinationTargetRoles: readonly SessionRole[];
  principal: Extract<SessionAuthorityPrincipal, { kind: "user" | "system" }>;
  proof: MutationAuthorityProof;
  expiresAt: string | null;
  issuedAt: string;
}): readonly SessionAuthorityGrant[] {
  const trustedPrincipal = input.principal;
  const proofPrincipal = input.proof.principal;
  const matchingTrustedProof = trustedPrincipal.kind === "user"
    ? proofPrincipal.kind === "user" && proofPrincipal.receiptId === trustedPrincipal.receiptId
    : proofPrincipal.kind === "system" && proofPrincipal.service === trustedPrincipal.service;
  if (!matchingTrustedProof) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Cross-root transfer capability requires matching trusted authority.");
  }
  const source = requireRoleBinding(db, input.sourceActorSessionId);
  const destination = requireRoleBinding(db, input.destinationRootSessionId);
  if (destination.root_session_id !== input.destinationRootSessionId || destination.parent_session_id !== null) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The transfer destination must be a root Session.");
  }
  const transferPermission = {
    mode: "exercise" as const,
    action: "session.move" as const,
    resourceKind: "session" as const,
    relationSelector: "root_owner" as const,
    effectClass: "local_mutation" as const,
    targetSessionRoles: input.destinationTargetRoles,
  };
  insertGrant(db, {
    rootSessionId: input.destinationRootSessionId,
    issuerKind: input.principal.kind,
    issuerId: input.principal.kind === "user" ? input.principal.receiptId : input.principal.service,
    issuerGrantId: null,
    issuerGrantRevision: null,
    granteeSessionId: input.sourceActorSessionId,
    permission: transferPermission,
    childCeiling: [
      ...input.destinationTargetRoles.flatMap((role) => baselineSessionAuthorityPermissions(role)),
      ...BUDGET_ACTIONS.map((action) => permission(action, "self")),
    ],
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    eventKind: "delegated",
    eventPrincipalKind: input.principal.kind,
    eventActorSessionId: null,
    provenance: {
      source: "trusted-cross-root-transfer",
      sourceRootSessionId: source.root_session_id,
      destinationRootSessionId: input.destinationRootSessionId,
    },
  });
  return listActiveSessionAuthorityGrants(db, input.sourceActorSessionId, new Date(input.issuedAt))
    .filter((grant) => grant.rootSessionId === input.destinationRootSessionId && grant.actions.includes("session.move"));
}

/**
 * Trusted internal provisioning for the bounded Work Item lifecycle surface.
 * This helper is deliberately narrower than the agent delegation API: it only
 * issues exercise grants, never changes baseline grants, and never creates a
 * child ceiling.
 */
export function issueTrustedWorkItemLifecycleCapability(db: DatabaseSync, input: {
  rootSessionId: string;
  granteeSessionId: string;
  actions: readonly SessionRuntimeOperation[];
  relationSelector: SessionAuthorityRelationSelector;
  targetSessionRoles: readonly SessionRole[];
  principal: Extract<SessionAuthorityPrincipal, { kind: "user" | "system" }>;
  proof: MutationAuthorityProof;
  expiresAt: string | null;
  issuedAt: string;
}): readonly SessionAuthorityGrant[] {
  const trustedPrincipal = input.principal;
  const proofPrincipal = input.proof.principal;
  const matchingTrustedProof = trustedPrincipal.kind === "user"
    ? proofPrincipal.kind === "user" && proofPrincipal.receiptId === trustedPrincipal.receiptId
    : proofPrincipal.kind === "system" && proofPrincipal.service === trustedPrincipal.service;
  if (!matchingTrustedProof) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Work Item lifecycle capability requires matching trusted authority.");
  }
  if (input.proof.mappingRevision !== SESSION_AUTHORITY_MAPPING_REVISION
    || input.proof.action !== input.proof.operation
    || !input.proof.operation.startsWith("work.")) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The trusted proof is not a current Work Item authority decision.");
  }
  const allowedActions = new Set<SessionRuntimeOperation>([
    "work.create", "work.get", "work.revise", "work.reassign", "work.move",
    "work.clone", "work.reopen", "work.archive", "work.restore", "work.delete",
    "work.history.append", "work.history.list", "work.result.correct", "work.aggregation.correct",
  ]);
  if (input.actions.length === 0 || input.actions.some((action) => !allowedActions.has(action))) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The lifecycle capability contains an unsupported Work Item action.");
  }
  if (new Set(input.actions).size !== input.actions.length
    || new Set(input.targetSessionRoles).size !== input.targetSessionRoles.length
    || input.targetSessionRoles.some((role) => !SESSION_ROLE_VALUES.includes(role))) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The lifecycle capability contains duplicate or invalid scope values.");
  }
  const root = requireRoleBinding(db, input.rootSessionId);
  const grantee = requireRoleBinding(db, input.granteeSessionId);
  if (root.root_session_id !== input.rootSessionId
    || grantee.root_session_id !== input.rootSessionId
    || input.proof.resolvedScope.rootSessionId !== input.rootSessionId) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The lifecycle capability is outside the trusted root scope.");
  }
  const issuedAt = new Date(input.issuedAt);
  const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
  if (!Number.isFinite(issuedAt.getTime()) || (expiresAt !== null && !Number.isFinite(expiresAt.getTime()))) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The lifecycle capability timestamps are invalid.");
  }
  if (expiresAt !== null && expiresAt.getTime() <= issuedAt.getTime()) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The lifecycle capability expiry must be after issuance.");
  }
  const before = new Set(listActiveSessionAuthorityGrants(db, input.granteeSessionId, issuedAt).map((grant) => grant.grantId));
  for (const action of input.actions) {
    const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[action];
    insertGrant(db, {
      rootSessionId: input.rootSessionId,
      issuerKind: trustedPrincipal.kind,
      issuerId: trustedPrincipal.kind === "user" ? trustedPrincipal.receiptId : trustedPrincipal.service,
      issuerGrantId: input.proof.grantId,
      issuerGrantRevision: input.proof.grantRevision,
      granteeSessionId: input.granteeSessionId,
      permission: {
        mode: "exercise",
        action,
        resourceKind: definition.resourceKind,
        relationSelector: input.relationSelector,
        effectClass: definition.effectClass,
        targetSessionRoles: input.targetSessionRoles,
      },
      childCeiling: [],
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      eventKind: "delegated",
      eventPrincipalKind: trustedPrincipal.kind,
      eventActorSessionId: null,
      provenance: {
        source: "trusted-work-item-lifecycle",
        trustedPrincipal: trustedPrincipal.kind === "user" ? trustedPrincipal.receiptId : trustedPrincipal.service,
        proofOperation: input.proof.operation,
        proofGrantId: input.proof.grantId,
        proofGrantRevision: input.proof.grantRevision,
        rootSessionId: input.rootSessionId,
        relationSelector: input.relationSelector,
        targetSessionRoles: input.targetSessionRoles,
        mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
      },
    });
  }
  const created = listActiveSessionAuthorityGrants(db, input.granteeSessionId, issuedAt)
    .filter((grant) => !before.has(grant.grantId) && grant.provenance.source === "trusted-work-item-lifecycle");
  if (created.length !== input.actions.length) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The lifecycle capability was not persisted.");
  }
  return created;
}

/**
 * Derive the initial grants for a newly-created root from an explicit
 * construction ceiling. A root id is never appended to an existing scope;
 * every derived grant has its own immutable provenance record.
 */
export function createDerivedRootAuthority(
  db: DatabaseSync,
  input: SessionAuthorityRootConstructionInput,
): readonly SessionAuthorityGrant[] {
  const source = requireGrant(db, input.sourceGrantId);
  assertGrantActive(source, source.granteeSessionId, input.sourceGrantRevision, new Date(input.createdAt));
  if (source.rootSessionId !== input.sourceRootSessionId
    || !source.actions.includes("session.create")
    || source.effectClass !== "local_mutation"
    || !source.delegable) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The source grant is not a root construction capability.");
  }
  requireRoleBinding(db, input.targetRootSessionId);
  if (input.ceiling.expiresAt !== null
    && (source.expiresAt === null || input.ceiling.expiresAt > source.expiresAt)) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The root construction expiry exceeds the source grant.");
  }
  const capability = readConstructionCeiling(source);
  if (!capability) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The source grant has no persisted root construction capability.");
  }
  if (capability.workspaceId !== input.ceiling.workspaceId
    || capability.projectId !== input.ceiling.projectId
    || capability.visibility !== input.ceiling.visibility) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The root construction placement exceeds the source capability.");
  }
  const allowed = capability.actions;
  for (const requested of input.ceiling.actions) {
    if (!allowed.some((candidate) => samePermission(candidate, requested))) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The root construction action exceeds the source grant ceiling.");
    }
  }
  for (const [dimension, requested] of Object.entries(input.ceiling.budget)) {
    const maximum = capability.budget[dimension];
    if (maximum === undefined || requested > maximum) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The root construction budget exceeds the source capability.");
    }
  }
  for (const amount of Object.values(input.ceiling.budget)) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The root construction budget ceiling is invalid.");
    }
  }
  const provenance = {
    source: "root-construction",
    operationId: input.operationId,
    sourceRootSessionId: input.sourceRootSessionId,
    sourceGrantId: source.grantId,
    sourceGrantRevision: source.revision,
    constructionCeiling: input.ceiling,
    lineage: { sourceRootSessionId: input.sourceRootSessionId },
  } as const;
  for (const item of input.ceiling.actions) {
    insertGrant(db, {
      rootSessionId: input.targetRootSessionId,
      issuerKind: "agent",
      issuerId: source.granteeSessionId,
      issuerGrantId: source.grantId,
      issuerGrantRevision: source.revision,
      granteeSessionId: input.targetRootSessionId,
      permission: item,
      childCeiling: [],
      issuedAt: input.createdAt,
      expiresAt: input.ceiling.expiresAt,
      eventKind: "delegated",
      eventPrincipalKind: "agent",
      eventActorSessionId: source.granteeSessionId,
      provenance,
    });
  }
  return listActiveSessionAuthorityGrants(db, input.targetRootSessionId, new Date(input.createdAt));
}

function readConstructionCeiling(grant: SessionAuthorityGrant): SessionAuthorityConstructionCeiling | null {
  const value = grant.provenance.constructionCeiling;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((typeof record.workspaceId !== "string" && record.workspaceId !== null)
    || (typeof record.projectId !== "string" && record.projectId !== null)
    || typeof record.visibility !== "string"
    || !Array.isArray(record.actions)
    || !record.actions.every((item) => item && typeof item === "object")
    || !record.budget || typeof record.budget !== "object" || Array.isArray(record.budget)
    || (typeof record.expiresAt !== "string" && record.expiresAt !== null)) return null;
  const budget = record.budget as Record<string, unknown>;
  if (Object.values(budget).some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) return null;
  return {
    workspaceId: record.workspaceId as string | null,
    projectId: record.projectId as string | null,
    visibility: record.visibility,
    actions: record.actions as SessionAuthorityPermission[],
    budget: budget as Record<string, number>,
    expiresAt: record.expiresAt as string | null,
  };
}

/**
 * Cross-root transfer creates fresh grant identities. Revoked grants are never
 * restored; the destination issuer must be active and explicit.
 */
export function transferSessionAuthority(db: DatabaseSync, input: {
  sessionId: string;
  sourceRootSessionId: string;
  destinationRootSessionId: string;
  destinationIssuerGrantId: string;
  destinationIssuerGrantRevision: number;
  operationId: string;
  transferredAt: string;
  /**
   * A whole-root merge consumes the temporary source-root transfer capability.
   * The caller must identify the exact capability used for that move; this is
   * intentionally not a general-purpose grant retirement switch.
   */
  retireSourceTransferCapabilityGrantId?: string;
}): readonly SessionAuthorityGrant[] {
  const destinationIssuer = requireGrant(db, input.destinationIssuerGrantId);
  assertGrantActive(destinationIssuer, destinationIssuer.granteeSessionId,
    input.destinationIssuerGrantRevision, new Date(input.transferredAt));
  if (destinationIssuer.rootSessionId !== input.destinationRootSessionId) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The destination issuer belongs to another root.");
  }
  const rows = db.prepare(`SELECT * FROM session_authority_grants_v6
    WHERE grantee_session_id = ? AND root_session_id = ? AND revoked_at IS NULL`)
    .all(input.sessionId, input.sourceRootSessionId) as GrantRow[];
  const sourceGrants = rows.map(decodeGrant);
  const retiredCapabilityId = input.retireSourceTransferCapabilityGrantId ?? null;
  if (retiredCapabilityId !== null) {
    const retiredCapability = sourceGrants.find((grant) => grant.grantId === retiredCapabilityId);
    if (!retiredCapability || !isSourceTransferCapability(retiredCapability, input.sourceRootSessionId, input.sessionId)) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "Only the exact trusted source-root transfer capability may be retired.", {
        grantId: retiredCapabilityId,
      });
    }
  }
  const now = new Date(input.transferredAt);
  for (const grant of sourceGrants) {
    assertGrantActive(grant, grant.granteeSessionId, grant.revision, now);
    assertIssuerChainCurrent(db, grant, now);
    if (grant.grantId === retiredCapabilityId) continue;
    const grantPermission = (action: SessionRuntimeOperation): SessionAuthorityPermission => ({
      mode: grant.delegable ? "delegate" : "exercise", action,
      resourceKind: grant.resourceKind, relationSelector: grant.relationSelector,
      effectClass: grant.effectClass, targetSessionRoles: grant.targetSessionRoles,
    });
    if (!grant.actions.every((action) => ceilingAllowsPermission(destinationIssuer.childCeiling, grantPermission(action)))
      || !grant.childCeiling.every((ceiling) => ceilingAllowsPermission(destinationIssuer.childCeiling, ceiling))) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The destination transfer ceiling does not permit the source grant.");
    }
    if (grant.expiresAt !== null && destinationIssuer.expiresAt !== null && grant.expiresAt > destinationIssuer.expiresAt) {
      // The destination expiry narrows the resulting grant; it may not extend it.
      continue;
    }
  }
  for (const grant of sourceGrants) {
    revokeSessionAuthorityGrant(db, {
      grantId: grant.grantId,
      expectedRevision: grant.revision,
      principal: { kind: "system", service: "session-transfer" },
      revokedAt: input.transferredAt,
    });
    if (grant.grantId === retiredCapabilityId) continue;
    insertGrant(db, {
      rootSessionId: input.destinationRootSessionId,
      issuerKind: "system",
      issuerId: "session-transfer",
      issuerGrantId: destinationIssuer.grantId,
      issuerGrantRevision: destinationIssuer.revision,
      granteeSessionId: input.sessionId,
      actions: grant.actions,
      permission: {
        mode: grant.delegable ? "delegate" : "exercise",
        action: grant.actions[0],
        resourceKind: grant.resourceKind,
        relationSelector: grant.relationSelector,
        effectClass: grant.effectClass,
        targetSessionRoles: grant.targetSessionRoles,
      },
      childCeiling: grant.childCeiling,
      issuedAt: input.transferredAt,
      expiresAt: earlierExpiry(grant.expiresAt, destinationIssuer.expiresAt),
      eventKind: "delegated",
      eventPrincipalKind: "system",
      eventActorSessionId: null,
      provenance: {
        ...Object.fromEntries(Object.entries(grant.provenance).filter(([key]) =>
          ["resourceIds", "purpose", "completionCriteria", "returnSessionId", "budgetAccountId", "budget"].includes(key))),
        source: "session-transfer",
        operationId: input.operationId,
        supersedesGrantId: grant.grantId,
        supersedesGrantRevision: grant.revision + 1,
        destinationIssuerGrantId: destinationIssuer.grantId,
        destinationIssuerGrantRevision: destinationIssuer.revision,
      },
    });
  }
  return listActiveSessionAuthorityGrants(db, input.sessionId, new Date(input.transferredAt));
}

function earlierExpiry(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

export function listActiveSessionAuthorityGrants(
  db: DatabaseSync,
  sessionId: string,
  now: Date,
): SessionAuthorityGrant[] {
  const timestamp = now.toISOString();
  return (db.prepare(`
    SELECT * FROM session_authority_grants_v6
    WHERE grantee_session_id = ?
      AND mapping_revision = ?
      AND effective_at <= ?
      AND (expires_at IS NULL OR expires_at > ?)
      AND revoked_at IS NULL
    ORDER BY grant_id
  `).all(sessionId, SESSION_AUTHORITY_MAPPING_REVISION, timestamp, timestamp) as GrantRow[]).map(decodeGrant);
}

export function assertGrantProofCurrent(
  db: DatabaseSync,
  proof: MutationAuthorityProof,
  now = new Date(),
  targetSessionRole?: SessionRole,
): void {
  if (proof.effectClass !== "read" && !["session.move", "turn.cancel", "work.cancel", "coordination.event.cancel", "delegation.cancel", "delegation.compensate", "grant.revoke"].includes(proof.operation)) {
    const actor = proof.principal.kind === "agent" ? requireRoleBinding(db, proof.principal.actorSessionId) : null;
    assertSessionMutationNotDraining(db, [proof.resolvedScope.rootSessionId, ...(actor ? [actor.root_session_id] : [])]);
  }
  if (proof.principal.kind !== "agent") return;
  requireRoleBinding(db, proof.principal.actorSessionId);
  if (proof.resolvedScope.ownerKind === "session") {
    requireRoleBinding(db, proof.resolvedScope.ownerId);
  }
  if (proof.grantId === null || proof.grantRevision === null) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Agent authority proof is missing its grant identity.");
  }
  if (proof.mappingRevision !== SESSION_AUTHORITY_MAPPING_REVISION) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The authority operation mapping revision is stale.");
  }
  const grant = requireGrant(db, proof.grantId);
  if (grant.mappingRevision !== SESSION_AUTHORITY_MAPPING_REVISION) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The authority grant mapping revision is stale.");
  }
  assertGrantActive(grant, proof.principal.actorSessionId, proof.grantRevision, now);
  assertGrantBudgetAccount(db, grant, proof.resolvedScope.ownerId);
  if (grant.rootSessionId !== proof.resolvedScope.rootSessionId || !grantAllows(grant, proof, targetSessionRole)) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The authority proof no longer matches the canonical resource scope.");
  }
  assertIssuerChainCurrent(db, grant, now);
}

function isSourceTransferCapability(
  grant: SessionAuthorityGrant,
  sourceRootSessionId: string,
  actorSessionId: string,
): boolean {
  return grant.provenance.source === "trusted-cross-root-transfer"
    && grant.provenance.sourceRootSessionId === sourceRootSessionId
    && grant.provenance.destinationRootSessionId === sourceRootSessionId
    && grant.rootSessionId === sourceRootSessionId
    && grant.granteeSessionId === actorSessionId
    && grant.actions.length === 1
    && grant.actions[0] === "session.move"
    && grant.resourceKind === "session"
    && grant.relationSelector === "root_owner"
    && grant.effectClass === "local_mutation";
}

/** A pending move already records both roots; its existing recovery operation releases the drain. */
function assertSessionMutationNotDraining(db: DatabaseSync, roots: readonly string[]): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_lifecycle_operations_v6'").get()) return;
  const placeholders = roots.map(() => "?").join(",");
  const pending = db.prepare(`SELECT operation_id FROM session_lifecycle_operations_v6
    WHERE operation = 'session.move' AND state IN ('prepared', 'running', 'recovery-required')
      AND source_root_session_id <> destination_root_session_id
      AND (source_root_session_id IN (${placeholders}) OR destination_root_session_id IN (${placeholders})) LIMIT 1`)
    .get(...roots, ...roots) as { operation_id: string } | undefined;
  if (pending) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The root is draining for an ownership transfer; read, cancel, and transfer recovery remain available.", { operationId: pending.operation_id });
}

function assertIssuerChainCurrent(db: DatabaseSync, grant: SessionAuthorityGrant, now: Date): void {
  let current = grant;
  const visited = new Set<string>();
  while (current.issuerGrantId !== null) {
    if (visited.has(current.grantId)) {
      throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The authority grant issuer chain contains a cycle.");
    }
    visited.add(current.grantId);
    const parent = requireGrant(db, current.issuerGrantId);
    requireRoleBinding(db, parent.granteeSessionId);
    assertGrantActive(parent, parent.granteeSessionId, current.issuerGrantRevision ?? -1, now);
    current = parent;
  }
}

export function revokeSessionAuthorityGrant(db: DatabaseSync, input: {
  grantId: string;
  expectedRevision: number;
  principal: SessionAuthorityPrincipal;
  revokedAt: string;
  payload?: Record<string, unknown>;
}): SessionAuthorityGrant {
  const current = requireGrant(db, input.grantId);
  if (current.revision !== input.expectedRevision) {
    throw new SessionAuthorityError("AUTHORITY_GRANT_REVISION_CONFLICT", "The authority grant revision is stale.", {
      grantId: input.grantId,
      currentRevision: current.revision,
    });
  }
  if (current.revokedAt !== null) return current;
  const nextRevision = current.revision + 1;
  db.prepare(`UPDATE session_authority_grants_v6 SET revoked_at = ?, revision = ? WHERE grant_id = ? AND revision = ?`)
    .run(input.revokedAt, nextRevision, input.grantId, input.expectedRevision);
  db.prepare(`
    INSERT INTO session_authority_grant_events_v6 (
      event_id, grant_id, event_kind, grant_revision, principal_kind, actor_session_id, payload_json, occurred_at
    ) VALUES (?, ?, 'revoked', ?, ?, ?, ?, ?)
  `).run(`authority-event:${randomUUID()}`, input.grantId, nextRevision, input.principal.kind, input.principal.kind === "agent" ? input.principal.actorSessionId : null, JSON.stringify(input.payload ?? {}), input.revokedAt);
  return requireGrant(db, input.grantId);
}

export function appendResourceEventHeader(db: DatabaseSync, header: ResourceEventHeader): void {
  db.prepare(`
    INSERT INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind,
      resource_revision, principal_kind, actor_session_id, grant_id, grant_revision,
      operation_id, idempotency_key_fingerprint, occurred_at, committed_at,
      supersedes_event_id, payload_schema_revision, effect
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    header.eventId, header.resourceKind, header.resourceId, header.rootId, header.ownerKind,
    header.ownerId, header.eventKind, header.resourceRevision, header.principalKind,
    header.actorSessionId, header.grantId, header.grantRevision, header.operationId,
    header.idempotencyKeyFingerprint, header.occurredAt, header.committedAt,
    header.supersedesEventId, header.payloadSchemaRevision, header.effect,
  );
}

export function verifySessionAuthorityMigration(db: DatabaseSync): void {
  const registered = db.prepare("SELECT operation, mapping_revision FROM session_authority_operation_registry_v6 ORDER BY operation")
    .all() as Array<{ operation: string; mapping_revision: number }>;
  const actual = registered.map((row) => row.operation);
  if (actual.length !== SESSION_RUNTIME_OPERATIONS.length || SESSION_RUNTIME_OPERATIONS.some((operation) => !actual.includes(operation))) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "Session authority operation mapping is incomplete.");
  }
  if (registered.some((row) => row.mapping_revision !== SESSION_AUTHORITY_MAPPING_REVISION)) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "Session authority operation mapping revision is inconsistent.");
  }
  const bindings = db.prepare(`
    SELECT binding.session_id, binding.session_role, binding.root_session_id
    FROM session_role_bindings_v6 AS binding
    INNER JOIN sessions_v6 AS session ON session.id = binding.session_id
    WHERE session.deleted_at IS NULL
    ORDER BY session_id
  `).all() as Array<{ session_id: string; session_role: SessionRole; root_session_id: string }>;
  const readGrants = db.prepare(`
    SELECT *
    FROM session_authority_grants_v6
    WHERE grantee_session_id = ?
      AND mapping_revision = ?
    ORDER BY grant_id
  `);
  for (const binding of bindings) {
    const rows = readGrants.all(binding.session_id, SESSION_AUTHORITY_MAPPING_REVISION) as GrantRow[];
    const activeRows = rows.filter((row) => row.revoked_at === null);
    // Revoked role-baseline grants remain migration evidence and must be
    // included in the template comparison; backfill must not recreate them.
    const baselineRows = rows.filter((row) => grantProvenanceSource(row) === "role-baseline"
      && (row.revoked_at === null || row.root_session_id === binding.root_session_id));
    const delegatedRows = activeRows.filter((row) => grantProvenanceSource(row) === "child-construction");
    const budgetRows = activeRows.filter((row) => grantProvenanceSource(row) === "resource-budget-v1");
    const transferredRows = activeRows.filter((row) => grantProvenanceSource(row) === "session-transfer");
    const transferCapabilityRows = activeRows.filter((row) => grantProvenanceSource(row) === "trusted-cross-root-transfer");
    const lifecycleCapabilityRows = activeRows.filter((row) => grantProvenanceSource(row) === "trusted-work-item-lifecycle");
    const publicGrantRows = activeRows.filter((row) => ["agent-grant", "trusted-grant-policy"].includes(String(grantProvenanceSource(row))));
    if (baselineRows.length === 0 && delegatedRows.length === 0 && transferredRows.length === 0 && transferCapabilityRows.length === 0 && lifecycleCapabilityRows.length === 0) {
      throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "A Session has no recognized authority grant provenance.", {
        sessionId: binding.session_id,
      });
    }
    if (baselineRows.length > 0) verifyBaselineGrantSet(binding, baselineRows);
    verifyBudgetAuthorityGrantSet(binding.session_id, budgetRows, rows.filter((row) => row.root_session_id === binding.root_session_id),
      transferredRows.length > 0 ? transferredRows : undefined);
    const revokedBaselineRows = baselineRows.filter((row) => row.revoked_at !== null);
    if (baselineRows.length + delegatedRows.length + budgetRows.length + transferredRows.length + transferCapabilityRows.length + lifecycleCapabilityRows.length + publicGrantRows.length
      !== activeRows.length + revokedBaselineRows.length) {
      throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "A Session authority grant has unknown provenance.", {
        sessionId: binding.session_id,
      });
    }
  }
}

function verifyBudgetAuthorityGrantSet(sessionId: string, rows: GrantRow[], allRows: GrantRow[], transferredRows?: GrantRow[]): void {
  if (rows.length === 0 && transferredRows && transferredRows.length > 0) {
    const transferredActions = transferredRows.flatMap((row) => JSON.parse(row.actions_json) as string);
    if (BUDGET_ACTIONS.every((action) => transferredActions.includes(action))) return;
  }
  const source = allRows.find((row) => JSON.parse(row.actions_json).includes("session.self"));
  if (!source || rows.length !== BUDGET_ACTIONS.length || BUDGET_ACTIONS.some((action) =>
    rows.filter((row) => {
      const grant = decodeGrant(row);
      return grant.actions.length === 1 && grant.actions[0] === action
        && grant.rootSessionId === source.root_session_id && grant.granteeSessionId === sessionId
        && grant.issuerKind === "system" && grant.issuerId === "resource-budget-v1-migration"
        && grant.issuerGrantId === source.grant_id && grant.issuerGrantRevision === 1
        && grant.resourceKind === "budget" && grant.relationSelector === "self"
        && grant.effectClass === SESSION_AUTHORITY_OPERATION_DEFINITIONS[action].effectClass
        && !grant.delegable && grant.childCeiling.length === 0
        && [...grant.targetSessionRoles].sort().join() === [...ALL_ROLES].sort().join()
        && grant.expiresAt === source.expires_at
        && parseGrantProvenance(row).sourceGrantId === source.grant_id;
    }).length !== 1)) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "Budget authority grant set is inconsistent.", { sessionId });
  }
}

function verifyBaselineGrantSet(
  binding: { session_id: string; session_role: SessionRole; root_session_id: string },
  rows: readonly GrantRow[],
): void {
  // A Role change does not issue additional authority. Validate the immutable
  // issuance template recorded by the baseline, not the current display Role.
  const issuedRole = parseGrantProvenance(rows[0]).sessionRole;
  if (typeof issuedRole !== "string" || !SESSION_ROLE_VALUES.includes(issuedRole as SessionRole)) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The baseline issuance Role is invalid.", { sessionId: binding.session_id });
  }
  const baselineBinding = { ...binding, session_role: issuedRole as SessionRole };
  const expected = baselineSessionAuthorityPermissions(baselineBinding.session_role);
  const actualKeys = rows.map((row) => baselineGrantKey(baselineBinding, row));
  const expectedKeys = expected.map((item) => baselinePermissionKey(baselineBinding.session_role, item));
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => key === null)
    || expectedKeys.some((key) => actualKeys.filter((candidate) => candidate === key).length !== 1)
  ) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "A Session baseline authority grant set does not match its Role template.", {
      sessionId: binding.session_id,
      sessionRole: binding.session_role,
    });
  }
}

function baselineGrantKey(
  binding: { session_id: string; session_role: SessionRole; root_session_id: string },
  row: GrantRow,
): string | null {
  const grant = decodeGrant(row);
  const provenance = parseGrantProvenance(row);
  if (
    grant.rootSessionId !== binding.root_session_id
    || grant.issuerKind !== "system"
    || grant.issuerId !== "session-authority-baseline-migration"
    || grant.issuerGrantId !== null
    || grant.issuerGrantRevision !== null
    || grant.granteeSessionId !== binding.session_id
    || grant.actions.length !== 1
    || grant.expiresAt !== null
    || provenance.source !== "role-baseline"
    || provenance.sessionRole !== binding.session_role
    || provenance.mappingRevision !== SESSION_AUTHORITY_MAPPING_REVISION
  ) return null;
  return permissionKey({
    mode: grant.delegable ? "delegate" : "exercise",
    action: grant.actions[0]!,
    resourceKind: grant.resourceKind,
    relationSelector: grant.relationSelector,
    effectClass: grant.effectClass,
    targetSessionRoles: grant.targetSessionRoles,
  }) + `|ceiling:${permissionSetKey(grant.childCeiling)}`;
}

function baselinePermissionKey(role: SessionRole, item: SessionAuthorityPermission): string {
  const childCeiling = childCeilingFor(role, item.action);
  const mode = item.mode === "delegate" || childCeiling.length > 0 ? "delegate" : "exercise";
  return permissionKey({ ...item, mode }) + `|ceiling:${permissionSetKey(childCeiling)}`;
}

function permissionSetKey(items: readonly SessionAuthorityPermission[]): string {
  return items.map(permissionKey).sort().join(",");
}

function permissionKey(item: SessionAuthorityPermission): string {
  return [
    item.mode,
    item.action,
    item.resourceKind,
    item.relationSelector,
    item.effectClass,
    [...item.targetSessionRoles].sort().join(","),
  ].join("|");
}

function grantProvenanceSource(row: GrantRow): unknown {
  return parseGrantProvenance(row).source;
}

function parseGrantProvenance(row: GrantRow): Record<string, unknown> {
  const value = JSON.parse(row.provenance_json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireRoleBinding(db: DatabaseSync, sessionId: string): RoleBindingRow {
  const row = db.prepare(`
    SELECT binding.session_role, binding.root_session_id, binding.parent_session_id
    FROM session_role_bindings_v6 AS binding
    INNER JOIN sessions_v6 AS session ON session.id = binding.session_id
    WHERE binding.session_id = ? AND session.deleted_at IS NULL
  `).get(sessionId) as RoleBindingRow | undefined;
  if (!row || !SESSION_ROLE_VALUES.includes(row.session_role)) {
    throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The canonical Session Role binding is unavailable.", { sessionId });
  }
  return row;
}

function insertGrant(db: DatabaseSync, input: {
  rootSessionId: string;
  issuerKind: SessionAuthorityPrincipal["kind"];
  issuerId: string;
  issuerGrantId: string | null;
  issuerGrantRevision: number | null;
  granteeSessionId: string;
  actions?: readonly SessionRuntimeOperation[];
  permission: SessionAuthorityPermission;
  childCeiling: readonly SessionAuthorityPermission[];
  issuedAt: string;
  expiresAt: string | null;
  eventKind: "baseline_issued" | "delegated";
  eventPrincipalKind: SessionAuthorityPrincipal["kind"];
  eventActorSessionId: string | null;
  provenance: Readonly<Record<string, unknown>>;
}): string {
  const grantId = `authority-grant:${randomUUID()}`;
  db.prepare(`
    INSERT INTO session_authority_grants_v6 (
      grant_id, root_session_id, issuer_kind, issuer_id, issuer_grant_id, issuer_grant_revision,
      grantee_session_id, actions_json, resource_kind, relation_selector, target_session_roles_json,
      effect_class, delegable, child_ceiling_json, issued_at, effective_at, expires_at, revoked_at,
      revision, mapping_revision, provenance_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(
    grantId, input.rootSessionId, input.issuerKind, input.issuerId, input.issuerGrantId,
    input.issuerGrantRevision, input.granteeSessionId, JSON.stringify(input.actions ?? [input.permission.action]),
    input.permission.resourceKind, input.permission.relationSelector,
    JSON.stringify(input.permission.targetSessionRoles), input.permission.effectClass,
    input.permission.mode === "delegate" || input.childCeiling.length > 0 ? 1 : 0,
    JSON.stringify(input.childCeiling), input.issuedAt, input.issuedAt, input.expiresAt,
    SESSION_AUTHORITY_MAPPING_REVISION, JSON.stringify(input.provenance),
  );
  db.prepare(`
    INSERT INTO session_authority_grant_events_v6 (
      event_id, grant_id, event_kind, grant_revision, principal_kind, actor_session_id, payload_json, occurred_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    `authority-event:${randomUUID()}`, grantId, input.eventKind, input.eventPrincipalKind,
    input.eventActorSessionId, JSON.stringify(input.provenance), input.issuedAt,
  );
  return grantId;
}

function requireGrant(db: DatabaseSync, grantId: string): SessionAuthorityGrant {
  const row = db.prepare("SELECT * FROM session_authority_grants_v6 WHERE grant_id = ?").get(grantId) as GrantRow | undefined;
  if (!row) throw new SessionAuthorityError("AUTHORITY_GRANT_REVOKED", "The authority grant is unavailable.", { grantId });
  return decodeGrant(row);
}

function decodeGrant(row: GrantRow): SessionAuthorityGrant {
  return {
    grantId: row.grant_id,
    rootSessionId: row.root_session_id,
    issuerKind: row.issuer_kind,
    issuerId: row.issuer_id,
    issuerGrantId: row.issuer_grant_id,
    issuerGrantRevision: row.issuer_grant_revision,
    granteeSessionId: row.grantee_session_id,
    actions: JSON.parse(row.actions_json) as SessionRuntimeOperation[],
    resourceKind: row.resource_kind,
    relationSelector: row.relation_selector,
    targetSessionRoles: JSON.parse(row.target_session_roles_json) as SessionRole[],
    effectClass: row.effect_class,
    delegable: row.delegable === 1,
    childCeiling: JSON.parse(row.child_ceiling_json) as SessionAuthorityPermission[],
    issuedAt: row.issued_at,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revision: row.revision,
    mappingRevision: row.mapping_revision,
    provenance: parseGrantProvenance(row),
  };
}

function assertGrantActive(grant: SessionAuthorityGrant, granteeSessionId: string, revision: number, now: Date): void {
  if (grant.granteeSessionId !== granteeSessionId) {
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The authority grant belongs to another Session.");
  }
  if (grant.revision !== revision) {
    throw new SessionAuthorityError("AUTHORITY_GRANT_REVISION_CONFLICT", "The authority grant revision is stale.", {
      grantId: grant.grantId,
      currentRevision: grant.revision,
    });
  }
  if (grant.revokedAt !== null) {
    throw new SessionAuthorityError("AUTHORITY_GRANT_REVOKED", "The authority grant has been revoked.", { grantId: grant.grantId });
  }
  if (Date.parse(grant.effectiveAt) > now.getTime() || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now.getTime())) {
    throw new SessionAuthorityError("AUTHORITY_GRANT_EXPIRED", "The authority grant is not active.", { grantId: grant.grantId });
  }
}

export function grantAllows(
  grant: SessionAuthorityGrant,
  request: Pick<MutationAuthorityProof, "action" | "effectClass" | "resolvedScope">,
  targetRole?: SessionRole,
): boolean {
  const scopedResourceIds = grant.provenance.resourceIds;
  const resourceAllowed = scopedResourceIds === undefined
    || (Array.isArray(scopedResourceIds) && request.resolvedScope.resourceId !== null
      && scopedResourceIds.includes(grant.resourceKind === "execution" ? request.resolvedScope.ownerId : request.resolvedScope.resourceId));
  return resourceAllowed
    && grant.actions.includes(request.action)
    && grant.resourceKind === request.resolvedScope.resourceKind
    && grant.effectClass === request.effectClass
    && relationIncludes(grant.relationSelector, request.resolvedScope.relation)
    && (targetRole === undefined || grant.targetSessionRoles.includes(targetRole));
}

function relationIncludes(grant: SessionAuthorityRelationSelector, actual: SessionAuthorityRelationSelector): boolean {
  if (grant === actual) return true;
  if (grant === "root_member" || grant === "visible_root") {
    return actual !== "visible_root";
  }
  return false;
}

function samePermission(left: SessionAuthorityPermission, right: SessionAuthorityPermission): boolean {
  return left.action === right.action
    && left.resourceKind === right.resourceKind
    && left.relationSelector === right.relationSelector
    && left.effectClass === right.effectClass
    && right.targetSessionRoles.every((role) => left.targetSessionRoles.includes(role));
}

function ceilingAllowsPermission(ceiling: readonly SessionAuthorityPermission[], requested: SessionAuthorityPermission): boolean {
  return ceiling.some((candidate) => samePermission(candidate, requested)
    && (requested.mode !== "delegate" || candidate.mode === "delegate"));
}

function relationCanNarrow(parent: SessionAuthorityRelationSelector, child: SessionAuthorityRelationSelector): boolean {
  if (parent === child) return true;
  return parent === "root_member" || parent === "visible_root";
}

function validateGrantBudget(budget: Readonly<Record<string, number>> | undefined, parent: Pick<SessionAuthorityGrant, "provenance">): void {
  const parentBudget = parent.provenance.budget;
  if (budget === undefined) {
    if (parentBudget !== undefined) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "A child grant must declare its bounded budget.");
    return;
  }
  for (const [key, value] of Object.entries(budget)) {
    if (!RESOURCE_BUDGET_DIMENSIONS.includes(key as typeof RESOURCE_BUDGET_DIMENSIONS[number]) || !Number.isSafeInteger(value) || value < 0) {
      throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant budget is invalid.", { dimension: key });
    }
  }
  if (!parentBudget || typeof parentBudget !== "object" || Array.isArray(parentBudget)) return;
  for (const [key, value] of Object.entries(budget)) {
    const maximum = (parentBudget as Record<string, unknown>)[key];
    if (typeof maximum !== "number" || value > maximum) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The grant budget exceeds its parent allocation.", { dimension: key });
    }
  }
  for (const key of Object.keys(parentBudget)) if (!(key in budget)) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The child omits a constrained budget dimension.");
}

function assertGrantBudgetAccount(db: DatabaseSync, grant: Pick<SessionAuthorityGrant, "rootSessionId" | "provenance">, ownerId?: string): void {
  const accountId = grant.provenance.budgetAccountId;
  const ceiling = grant.provenance.budget;
  if (accountId === undefined && ceiling === undefined) return;
  if (typeof accountId !== "string") throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "A bounded grant requires an existing budget account.");
  const requestedOwnerId = ownerId ?? grant.rootSessionId;
  let account = db.prepare(`
    SELECT account_id, root_session_id, revoked_at
    FROM resource_budget_accounts_v6
    WHERE owner_session_id = ?
    ORDER BY CASE account_kind WHEN 'session' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(requestedOwnerId) as { account_id: string; root_session_id: string; revoked_at: string | null } | undefined;
  if (!account) {
    const binding = db.prepare("SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
      .get(requestedOwnerId) as { root_session_id: string } | undefined;
    if (binding) {
      account = db.prepare(`
        SELECT account_id, root_session_id, revoked_at
        FROM resource_budget_accounts_v6
        WHERE account_id = ?
        LIMIT 1
      `).get(binding.root_session_id) as { account_id: string; root_session_id: string; revoked_at: string | null } | undefined;
    }
  }
  if (!account || account.account_id !== accountId || account.root_session_id !== grant.rootSessionId || account.revoked_at !== null) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant budget is not the target's current account.");
  }
  if (ceiling && typeof ceiling === "object" && !Array.isArray(ceiling)) {
    for (const [key, maximum] of Object.entries(ceiling)) {
      if (!RESOURCE_BUDGET_DIMENSIONS.includes(key as typeof RESOURCE_BUDGET_DIMENSIONS[number])) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The grant budget contains an unknown dimension.", { dimension: key });
      const dimension = db.prepare("SELECT hard_limit FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = ?")
        .get(account.account_id, key) as { hard_limit: number } | undefined;
      if (!dimension || typeof maximum !== "number" || dimension.hard_limit > maximum) throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "Configure a budget allocation within the grant ceiling before admission.");
    }
  }
}

function requireGrantResourceOwner(db: DatabaseSync, kind: SessionAuthorityResourceKind, id: string, rootSessionId: string, actions: readonly SessionRuntimeOperation[]): string {
  let row: { root_session_id: string; owner_session_id: string } | undefined;
  if (kind === "work_item") {
    row = db.prepare("SELECT root_session_id, target_session_id AS owner_session_id FROM work_items_v6 WHERE id = ?").get(id) as typeof row;
  } else if (kind === "interaction") {
    row = db.prepare(`SELECT binding.root_session_id, binding.session_id AS owner_session_id FROM session_interactions_v6 interaction
      JOIN session_executions_v6 execution ON execution.id = interaction.execution_id
      JOIN session_role_bindings_v6 binding ON binding.session_id = execution.session_id WHERE interaction.id = ?`).get(id) as typeof row;
  } else if (kind === "coordination_event") {
    row = db.prepare("SELECT root_session_id, actor_session_id AS owner_session_id FROM coordination_events_v6 WHERE id = ?").get(id) as typeof row;
  } else {
    // Execution grants bind the target Session so the same bounded grant can admit and inspect a Turn.
    row = db.prepare(`SELECT binding.root_session_id, binding.session_id AS owner_session_id FROM session_role_bindings_v6 binding
      JOIN sessions_v6 session ON session.id = binding.session_id WHERE binding.session_id = ? AND session.deleted_at IS NULL`).get(id) as typeof row;
  }
  if (!row && actions.some((action) => ["session", "target_session"].includes(SESSION_AUTHORITY_OPERATION_DEFINITIONS[action].scopeSource))) {
    row = db.prepare(`SELECT binding.root_session_id, binding.session_id AS owner_session_id FROM session_role_bindings_v6 binding
      JOIN sessions_v6 session ON session.id = binding.session_id WHERE binding.session_id = ? AND session.deleted_at IS NULL`).get(id) as typeof row;
  }
  if (!row || row.root_session_id !== rootSessionId) throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "A resource must exist in the grant root.");
  return row.owner_session_id;
}
