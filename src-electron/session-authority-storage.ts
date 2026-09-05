import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  SessionAuthorityError,
  type MutationAuthorityProof,
  type ResourceEventHeader,
  type SessionAuthorityGrant,
  type SessionAuthorityPermission,
  type SessionAuthorityPrincipal,
  type SessionAuthorityRelationSelector,
  type SessionAuthorityResourceKind,
} from "../src/session-authority.js";
import { SESSION_RUNTIME_OPERATIONS, type SessionRuntimeOperation } from "../src/session-external-runtime-contract.js";
import { SESSION_ROLE_VALUES, type SessionRole } from "../src/session-role-binding.js";
import { ensureSessionAuthoritySchema } from "./session-authority-schema.js";

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
      AND issuer_kind = 'system'
      AND issuer_id = 'session-authority-baseline-migration'
      AND json_extract(provenance_json, '$.source') = 'role-baseline'
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
}

export function backfillBaselineSessionAuthority(db: DatabaseSync, issuedAt: string): void {
  ensureSessionAuthoritySchema(db);
  syncSessionAuthorityOperationRegistry(db);
  const rows = db.prepare(`
    SELECT session_id
    FROM session_role_bindings_v6
    ORDER BY delegation_depth, session_id
  `).all() as Array<{ session_id: string }>;
  for (const row of rows) ensureBaselineSessionAuthority(db, row.session_id, issuedAt);
  verifySessionAuthorityMigration(db);
}

export function createDelegatedChildAuthority(db: DatabaseSync, input: {
  parentProof: MutationAuthorityProof;
  childSessionId: string;
  operationId: string;
  createdAt: string;
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
  for (const item of template) {
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
      expiresAt: parentGrant.expiresAt,
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
  if (proof.principal.kind !== "agent") return;
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
  if (grant.rootSessionId !== proof.resolvedScope.rootSessionId || !grantAllows(grant, proof, targetSessionRole)) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The authority proof no longer matches the canonical resource scope.");
  }
  let current = grant;
  const visited = new Set<string>();
  while (current.issuerGrantId !== null) {
    if (visited.has(current.grantId)) {
      throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "The authority grant issuer chain contains a cycle.");
    }
    visited.add(current.grantId);
    const parent = requireGrant(db, current.issuerGrantId);
    assertGrantActive(parent, parent.granteeSessionId, current.issuerGrantRevision ?? -1, now);
    current = parent;
  }
}

export function revokeSessionAuthorityGrant(db: DatabaseSync, input: {
  grantId: string;
  expectedRevision: number;
  principal: Extract<SessionAuthorityPrincipal, { kind: "user" | "system" }>;
  revokedAt: string;
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
    ) VALUES (?, ?, 'revoked', ?, ?, NULL, ?, ?)
  `).run(`authority-event:${randomUUID()}`, input.grantId, nextRevision, input.principal.kind, JSON.stringify({}), input.revokedAt);
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
    SELECT session_id, session_role, root_session_id
    FROM session_role_bindings_v6
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
    const baselineRows = rows.filter((row) => grantProvenanceSource(row) === "role-baseline");
    const delegatedRows = rows.filter((row) => grantProvenanceSource(row) === "child-construction");
    if (baselineRows.length === 0 && delegatedRows.length === 0) {
      throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "A Session has no recognized authority grant provenance.", {
        sessionId: binding.session_id,
      });
    }
    if (baselineRows.length > 0) verifyBaselineGrantSet(binding, baselineRows);
    if (baselineRows.length + delegatedRows.length !== rows.length) {
      throw new SessionAuthorityError("AUTHORITY_MIGRATION_REQUIRED", "A Session authority grant has unknown provenance.", {
        sessionId: binding.session_id,
      });
    }
  }
}

function verifyBaselineGrantSet(
  binding: { session_id: string; session_role: SessionRole; root_session_id: string },
  rows: readonly GrantRow[],
): void {
  const expected = baselineSessionAuthorityPermissions(binding.session_role);
  const actualKeys = rows.map((row) => baselineGrantKey(binding, row));
  const expectedKeys = expected.map((item) => baselinePermissionKey(binding.session_role, item));
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
    SELECT session_role, root_session_id, parent_session_id
    FROM session_role_bindings_v6
    WHERE session_id = ?
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
  permission: SessionAuthorityPermission;
  childCeiling: readonly SessionAuthorityPermission[];
  issuedAt: string;
  expiresAt: string | null;
  eventKind: "baseline_issued" | "delegated";
  eventPrincipalKind: SessionAuthorityPrincipal["kind"];
  eventActorSessionId: string | null;
  provenance: Readonly<Record<string, unknown>>;
}): void {
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
    input.issuerGrantRevision, input.granteeSessionId, JSON.stringify([input.permission.action]),
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
  return grant.actions.includes(request.action)
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
