import type { DatabaseSync } from "node:sqlite";

import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  SessionAuthorityError,
  type AuthorizedOperation,
  type MutationAdmissionProof,
  type ResolvedSessionAuthorityScope,
  type SessionAuthorityGrant,
  type SessionAuthorityRelationSelector,
} from "../src/session-authority.js";
import type { SessionRuntimeOperation } from "../src/session-external-runtime-contract.js";
import type { SessionRole } from "../src/session-role-binding.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import {
  assertGrantProofCurrent,
  backfillBaselineSessionAuthority,
  grantAllows,
  listActiveSessionAuthorityGrants,
  verifySessionAuthorityMigration,
} from "./session-authority-storage.js";
import { openAppDatabase } from "./sqlite-connection.js";

type SessionAuthorityServiceOptions = {
  databasePath: string;
  getExecutionGeneration(actorSessionId: string, providerId: string): string | null;
  now?: () => Date;
};

type SessionIdentity = {
  sessionId: string;
  role: SessionRole;
  rootSessionId: string;
  parentSessionId: string | null;
};

type ScopeCandidate = {
  scope: ResolvedSessionAuthorityScope;
  targetRole?: SessionRole;
};

export class SessionAuthorityService {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(private readonly options: SessionAuthorityServiceOptions) {
    this.db = openAppDatabase(options.databasePath);
    this.now = options.now ?? (() => new Date());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      backfillBaselineSessionAuthority(this.db, this.now().toISOString());
      verifySessionAuthorityMigration(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  authorize<T>(
    binding: ResolvedAgentRuntimeBinding,
    operation: SessionRuntimeOperation,
    input: T,
    now = this.now(),
  ): AuthorizedOperation<T> {
    const currentGeneration = this.options.getExecutionGeneration(binding.actorSessionId, binding.providerId);
    if (currentGeneration === null || currentGeneration !== binding.executionGeneration) {
      throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "The Session runtime generation is stale.", {
        actorSessionId: binding.actorSessionId,
      });
    }
    const proof = this.authorizeCanonicalSession(binding.actorSessionId, operation, input, now, {
      providerId: binding.providerId,
      executionGeneration: binding.executionGeneration,
    });
    return { input, proof };
  }

  canSessionAct(
    actorSessionId: string,
    operation: SessionRuntimeOperation,
    input: unknown,
    now = this.now(),
  ): boolean {
    try {
      this.authorizeCanonicalSession(actorSessionId, operation, input, now, {
        providerId: "internal",
        executionGeneration: "internal",
      });
      return true;
    } catch (error) {
      if (error instanceof SessionAuthorityError) return false;
      throw error;
    }
  }

  private authorizeCanonicalSession(
    actorSessionId: string,
    operation: SessionRuntimeOperation,
    input: unknown,
    now: Date,
    runtime: { providerId: string; executionGeneration: string },
  ): MutationAdmissionProof {
    const actor = requireSessionIdentity(this.db, actorSessionId);
    const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
    const scopes = resolveScopes(this.db, actor, operation, input);
    const grants = listActiveSessionAuthorityGrants(this.db, actor.sessionId, now);
    for (const candidate of scopes) {
      const request = {
        action: definition.action,
        effectClass: definition.effectClass,
        resolvedScope: candidate.scope,
      };
      const grant = grants.find((item) => grantAllows(item, request, candidate.targetRole));
      if (!grant) continue;
      const proof = buildProof(actor, operation, runtime, candidate.scope, grant, now);
      try {
        assertGrantProofCurrent(this.db, proof, now);
        return proof;
      } catch (error) {
        if (!(error instanceof SessionAuthorityError)) throw error;
      }
    }
    throw new SessionAuthorityError("AUTHORITY_FORBIDDEN", "No active authority grant permits this operation.", {
      actorSessionId: actor.sessionId,
      operation,
    });
  }
}

function buildProof(
  actor: SessionIdentity,
  operation: SessionRuntimeOperation,
  runtime: { providerId: string; executionGeneration: string },
  scope: ResolvedSessionAuthorityScope,
  grant: SessionAuthorityGrant,
  now: Date,
): MutationAdmissionProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return {
    principal: {
      kind: "agent",
      agent: "session-runtime",
      actorSessionId: actor.sessionId,
      runtimeGeneration: runtime.executionGeneration,
    },
    providerId: runtime.providerId,
    operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: definition.action,
    resolvedScope: scope,
    effectClass: definition.effectClass,
    grantId: grant.grantId,
    grantRevision: grant.revision,
    evaluatedAt: now.toISOString(),
  };
}

function resolveScopes(
  db: DatabaseSync,
  actor: SessionIdentity,
  operation: SessionRuntimeOperation,
  input: unknown,
): ScopeCandidate[] {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  const record = objectInput(input);
  if (definition.scopeSource === "actor") {
    if (operation === "session.create") {
      const targetRole = requiredSessionRole(record.sessionRole);
      return [scope(actor, "session_namespace", actor.sessionId, actor.sessionId, "self", targetRole)];
    }
    if (operation === "session.list") {
      return [scope(actor, "session", null, actor.sessionId, "root_member"), scope(actor, "session", null, actor.sessionId, "self")];
    }
    if (operation === "work.list") {
      return [
        scope(actor, "work_item", null, actor.sessionId, "root_member"),
        scope(actor, "work_item", null, actor.sessionId, "creator_or_target"),
      ];
    }
    if (operation === "coordination.event.create") {
      return [scope(actor, "coordination_event", null, actor.sessionId, "self")];
    }
    return [scope(actor, definition.resourceKind, actor.sessionId, actor.sessionId, "self")];
  }
  if (definition.scopeSource === "coordination_list") {
    const requestedScope = record.scope === "subtree" ? "subtree" : "self";
    if (requestedScope === "self") return [scope(actor, "coordination_event", null, actor.sessionId, "self")];
    return [
      scope(actor, "coordination_event", null, actor.sessionId, "root_member"),
      scope(actor, "coordination_event", null, actor.sessionId, "direct_child"),
    ];
  }
  if (definition.scopeSource === "target_session") {
    return sessionScopes(db, actor, requiredString(record.targetSessionId, "targetSessionId"), definition.resourceKind);
  }
  if (definition.scopeSource === "session") {
    return sessionScopes(db, actor, requiredString(record.sessionId, "sessionId"), definition.resourceKind);
  }
  if (definition.scopeSource === "work_item" || definition.scopeSource === "parent_work_item") {
    const key = definition.scopeSource === "parent_work_item" ? "parentWorkItemId" : "workItemId";
    return workItemScopes(db, actor, requiredString(record[key], key));
  }
  if (definition.scopeSource === "execution") {
    return executionScopes(db, actor, requiredString(record.executionId, "executionId"));
  }
  if (definition.scopeSource === "interaction") {
    return interactionScopes(db, actor, requiredString(record.interactionId, "interactionId"), operation);
  }
  if (definition.scopeSource === "coordination_event") {
    let eventId: string;
    if (typeof record.eventId === "string" && record.eventId.trim() !== "") {
      eventId = record.eventId.trim();
    } else if (operation === "coordination.event.get") {
      const idempotencyKey = requiredString(record.idempotencyKey, "idempotencyKey");
      const idempotency = db.prepare(`
        SELECT result_event_id
        FROM coordination_event_idempotency_v6
        WHERE principal_kind = 'agent' AND principal_id = ? AND idempotency_key = ?
      `).get(actor.sessionId, idempotencyKey) as { result_event_id: string } | undefined;
      if (!idempotency) return [];
      eventId = idempotency.result_event_id;
    } else {
      eventId = requiredString(record.eventId, "eventId");
    }
    return coordinationEventScopes(db, actor, eventId);
  }
  throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The operation authority scope cannot be resolved.", { operation });
}

function sessionScopes(
  db: DatabaseSync,
  actor: SessionIdentity,
  targetSessionId: string,
  resourceKind: ResolvedSessionAuthorityScope["resourceKind"],
): ScopeCandidate[] {
  const target = requireSessionIdentity(db, targetSessionId);
  if (target.rootSessionId !== actor.rootSessionId) return [];
  const relations = sessionRelations(actor, target);
  return relations.map((relation) => scope(actor, resourceKind, target.sessionId, target.sessionId, relation, target.role));
}

function workItemScopes(db: DatabaseSync, actor: SessionIdentity, workItemId: string): ScopeCandidate[] {
  const item = db.prepare(`
    SELECT id, root_session_id, creator_session_id, target_session_id, kind
    FROM work_items_v6 WHERE id = ?
  `).get(workItemId) as {
    id: string;
    root_session_id: string;
    creator_session_id: string;
    target_session_id: string;
    kind: "root" | "delegated";
  } | undefined;
  if (!item || item.root_session_id !== actor.rootSessionId) return [];
  const target = requireSessionIdentity(db, item.target_session_id);
  const values: ScopeCandidate[] = [];
  if (item.kind === "root" && item.root_session_id === actor.sessionId && item.creator_session_id === actor.sessionId) {
    values.push(scope(actor, "work_item", item.id, item.target_session_id, "owned_root", target.role));
  }
  if (item.target_session_id === actor.sessionId) values.push(scope(actor, "work_item", item.id, item.target_session_id, "assigned", target.role));
  if (item.creator_session_id === actor.sessionId) values.push(scope(actor, "work_item", item.id, item.target_session_id, "created", target.role));
  if (actor.sessionId === actor.rootSessionId) values.push(scope(actor, "work_item", item.id, item.target_session_id, "root_member", target.role));
  return values;
}

function executionScopes(db: DatabaseSync, actor: SessionIdentity, executionId: string): ScopeCandidate[] {
  const row = db.prepare(`
    SELECT execution.id, execution.session_id, origin.source_session_id
    FROM session_executions_v6 AS execution
    LEFT JOIN session_execution_origins_v6 AS origin ON origin.execution_id = execution.id
    WHERE execution.id = ?
  `).get(executionId) as { id: string; session_id: string; source_session_id: string | null } | undefined;
  if (!row) return [];
  const target = requireSessionIdentity(db, row.session_id);
  if (target.rootSessionId !== actor.rootSessionId) return [];
  const values = sessionScopes(db, actor, row.session_id, "execution");
  if (row.source_session_id === actor.sessionId || row.session_id === actor.sessionId) {
    values.unshift(scope(actor, "execution", row.id, row.session_id, "created", target.role));
  }
  return values.map((value) => ({ ...value, scope: { ...value.scope, resourceId: row.id } }));
}

function interactionScopes(
  db: DatabaseSync,
  actor: SessionIdentity,
  interactionId: string,
  operation: SessionRuntimeOperation,
): ScopeCandidate[] {
  const row = db.prepare(`
    SELECT interaction.id, execution.session_id, origin.source_session_id, interaction.decision_class
    FROM session_interactions_v6 AS interaction
    INNER JOIN session_executions_v6 AS execution ON execution.id = interaction.execution_id
    LEFT JOIN session_execution_origins_v6 AS origin ON origin.execution_id = execution.id
    WHERE interaction.id = ?
  `).get(interactionId) as {
    id: string;
    session_id: string;
    source_session_id: string | null;
    decision_class: "user_only" | "agent_delegable" | "deny_or_cancel";
  } | undefined;
  if (!row) return [];
  if (operation === "interaction.respond" && row.decision_class !== "agent_delegable") return [];
  const target = requireSessionIdentity(db, row.session_id);
  if (target.rootSessionId !== actor.rootSessionId) return [];
  const relation: SessionAuthorityRelationSelector = row.source_session_id === actor.sessionId || row.session_id === actor.sessionId
    ? "created"
    : sessionRelations(actor, target)[0] ?? "visible_root";
  return [scope(actor, "interaction", row.id, row.session_id, relation, target.role)];
}

function coordinationEventScopes(db: DatabaseSync, actor: SessionIdentity, eventId: string): ScopeCandidate[] {
  const row = db.prepare("SELECT id, actor_session_id, root_session_id FROM coordination_events_v6 WHERE id = ?")
    .get(eventId) as { id: string; actor_session_id: string; root_session_id: string } | undefined;
  if (!row || row.root_session_id !== actor.rootSessionId) return [];
  const owner = requireSessionIdentity(db, row.actor_session_id);
  const relations = owner.sessionId === actor.sessionId ? ["created" as const] : sessionRelations(actor, owner);
  return relations.map((relation) => scope(actor, "coordination_event", row.id, owner.sessionId, relation, owner.role));
}

function sessionRelations(actor: SessionIdentity, target: SessionIdentity): SessionAuthorityRelationSelector[] {
  if (actor.sessionId === target.sessionId) return ["self"];
  const values: SessionAuthorityRelationSelector[] = [];
  if (actor.parentSessionId === target.sessionId) values.push("parent");
  if (target.parentSessionId === actor.sessionId) values.push("direct_child");
  if (actor.parentSessionId !== null && actor.parentSessionId === target.parentSessionId) values.push("sibling");
  if (target.sessionId === actor.rootSessionId) values.push("root_owner");
  if (actor.sessionId === actor.rootSessionId) values.push("root_member");
  return values;
}

function scope(
  actor: SessionIdentity,
  resourceKind: ResolvedSessionAuthorityScope["resourceKind"],
  resourceId: string | null,
  ownerId: string,
  relation: SessionAuthorityRelationSelector,
  targetRole?: SessionRole,
): ScopeCandidate {
  return {
    scope: {
      resourceKind,
      resourceId,
      rootSessionId: actor.rootSessionId,
      ownerKind: "session",
      ownerId,
      relation,
    },
    ...(targetRole === undefined ? {} : { targetRole }),
  };
}

function requireSessionIdentity(db: DatabaseSync, sessionId: string): SessionIdentity {
  const row = db.prepare(`
    SELECT session_id, session_role, root_session_id, parent_session_id
    FROM session_role_bindings_v6 WHERE session_id = ?
  `).get(sessionId) as {
    session_id: string;
    session_role: SessionRole;
    root_session_id: string;
    parent_session_id: string | null;
  } | undefined;
  if (!row) {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The canonical Session identity was not found.", { sessionId });
  }
  return {
    sessionId: row.session_id,
    role: row.session_role,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The authority resource identity is missing.", { field });
  }
  return value.trim();
}

function requiredSessionRole(value: unknown): SessionRole {
  if (value === "standalone" || value === "overall-coordinator" || value === "task-coordinator" || value === "executor") {
    return value;
  }
  throw new SessionAuthorityError("AUTHORITY_SCOPE_INVALID", "The child Session Role is invalid.", { field: "sessionRole" });
}
