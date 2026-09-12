import type { DatabaseSync } from "node:sqlite";

import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof, type SessionAuthorityConstructionCeiling, type SessionAuthorityPermission } from "../src/session-authority.js";
import type { SessionRuntimeCreateInput, SessionRuntimeOperation } from "../src/session-external-runtime-contract.js";
import type { Session } from "../src/session-state.js";
import { SessionCrudError } from "./session-crud-service.js";
import { RESOURCE_BUDGET_DIMENSIONS, type ResourceBudgetAmounts } from "../src/resource-budget.js";
import {
  assertGrantProofCurrent,
  createDelegatedChildAuthority,
  createDerivedRootAuthority,
  ensureBaselineSessionAuthority,
  listActiveSessionAuthorityGrants,
} from "./session-authority-storage.js";
import { ResourceBudgetStorage } from "./resource-budget-storage.js";
import { bootstrapRootResourceBudget } from "./resource-budget-storage.js";

type ConstructionInput = SessionRuntimeCreateInput & Readonly<{
  workspaceId?: string | null;
  projectId?: string | null;
  visibility?: string;
}>;

function fail(message: string): never {
  throw new SessionCrudError("SESSION_STATE_CONFLICT", message, false);
}

function invalid(message: string): never {
  throw new SessionCrudError("INVALID_INPUT", message, false);
}

function binding(db: DatabaseSync, sessionId: string): { root_session_id: string; parent_session_id: string | null; resource_revision: number } {
  const row = db.prepare(`SELECT binding.root_session_id, binding.parent_session_id, session.resource_revision
    FROM session_role_bindings_v6 AS binding INNER JOIN sessions_v6 AS session ON session.id = binding.session_id
    WHERE binding.session_id = ?`).get(sessionId) as { root_session_id: string; parent_session_id: string | null; resource_revision: number } | undefined;
  if (!row) fail(`Session binding was not found: ${sessionId}`);
  return row;
}

function ceilingFromGrant(grant: { provenance: Readonly<Record<string, unknown>> }): SessionAuthorityConstructionCeiling {
  const value = grant.provenance.constructionCeiling;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("The source grant has no construction ceiling.");
  const record = value as Record<string, unknown>;
  if ((typeof record.workspaceId !== "string" && record.workspaceId !== null)
    || (typeof record.projectId !== "string" && record.projectId !== null)
    || typeof record.visibility !== "string" || !Array.isArray(record.actions)
    || !record.budget || typeof record.budget !== "object" || Array.isArray(record.budget)
    || (typeof record.expiresAt !== "string" && record.expiresAt !== null)) {
    invalid("The source grant construction ceiling is invalid.");
  }
  return record as unknown as SessionAuthorityConstructionCeiling;
}

function requestedBudget(input: ConstructionInput, ceiling: SessionAuthorityConstructionCeiling): ResourceBudgetAmounts {
  const requested = input.budget.kind === "explicit" ? input.budget.hardLimits : {};
  return Object.fromEntries(RESOURCE_BUDGET_DIMENSIONS.map((dimension) => {
    const maximum = ceiling.budget[dimension] ?? 0;
    const value = requested[dimension] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid(`The initial budget exceeds its construction ceiling: ${dimension}.`);
    }
    return [dimension, value];
  })) as ResourceBudgetAmounts;
}

function earlierExpiry(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function requestedRootCeiling(input: ConstructionInput, ceiling: SessionAuthorityConstructionCeiling): SessionAuthorityConstructionCeiling {
  const grant = input.initialGrant;
  const actions = grant.kind === "explicit" ? ceiling.actions.filter((item) => grant.actions.includes(item.action)) : ceiling.actions;
  if (grant.kind === "explicit" && grant.actions.some((action) => !ceiling.actions.some((item) => item.action === action))) {
    invalid("The root initial grant exceeds its construction ceiling.");
  }
  if (grant.kind === "explicit" && ceiling.expiresAt !== null
    && grant.expiresAt !== null && grant.expiresAt > ceiling.expiresAt) {
    invalid("The root initial grant expiry exceeds its construction ceiling.");
  }
  if (grant.kind === "explicit" && !grant.visibility.includes(ceiling.visibility)) {
    invalid("The root visibility exceeds its construction ceiling.");
  }
  if (actions.length === 0) invalid("The root initial grant must retain at least one allowed action.");
  if (input.budget.kind === "explicit" && ceiling.expiresAt !== null && input.budget.deadlineAt > ceiling.expiresAt) {
    invalid("The initial budget deadline exceeds its construction ceiling.");
  }
  const limits = requestedBudget(input, ceiling);
  const budget = Object.fromEntries(Object.keys(ceiling.budget).map((dimension) => [dimension, limits[dimension as keyof ResourceBudgetAmounts]]));
  return { ...ceiling, actions, budget, expiresAt: grant.kind === "explicit" && grant.expiresAt !== null ? grant.expiresAt : ceiling.expiresAt };
}

function assertRequestedActions(input: ConstructionInput, allowed: readonly SessionAuthorityPermission[]): string[] | undefined {
  if (input.initialGrant.kind === "inherit") return undefined;
  const grant = input.initialGrant;
  const allowedActions = new Set(allowed.map((item) => item.action));
  for (const action of grant.actions) if (!allowedActions.has(action as SessionRuntimeOperation)) {
    invalid(`The requested initial grant exceeds the parent authority: ${action}.`);
  }
  return grant.actions;
}

export function validateSessionConstruction(
  db: DatabaseSync,
  input: ConstructionInput,
  proof: MutationAuthorityProof,
  nextSession: Session,
  now: string,
): void {
  assertGrantProofCurrent(db, proof, new Date(now));
  const placement = input.placement;
  if (placement.kind === "child") {
    const parent = binding(db, placement.parentSessionId);
    if (parent.resource_revision !== input.expectedContainerRevision) throw new SessionCrudError("SESSION_REVISION_CONFLICT", "The parent Session resource revision is stale.", true);
    if (proof.principal.kind !== "agent" || proof.principal.actorSessionId !== placement.parentSessionId) {
      invalid("Child construction requires the parent Session authority proof.");
    }
    if (nextSession.roleBinding?.parentSessionId !== placement.parentSessionId) invalid("The child placement does not match the constructed Session.");
    const parentGrant = listActiveSessionAuthorityGrants(db, placement.parentSessionId, new Date(now))
      .find((grant) => grant.grantId === proof.grantId && grant.actions.includes("session.create"));
    if (!parentGrant) invalid("The parent construction grant is not active.");
    assertRequestedActions(input, parentGrant.childCeiling);
    return;
  }
  if (!nextSession.roleBinding || nextSession.roleBinding.rootSessionId !== nextSession.id || nextSession.roleBinding.parentSessionId !== null) {
    invalid("Root construction requires a root Session binding.");
  }
  if (proof.principal.kind === "user" || proof.principal.kind === "system") {
    if (input.initialGrant.kind === "explicit") {
      invalid("Explicit initial grants are unavailable for trusted root creation.");
    }
    return;
  }
  if (proof.principal.kind !== "agent" || proof.grantId === null || proof.grantRevision === null) {
    invalid("Root construction requires an admitted construction grant.");
  }
  const source = listActiveSessionAuthorityGrants(db, proof.principal.actorSessionId, new Date(now)).find((grant) => grant.grantId === proof.grantId);
  if (!source) invalid("The root construction grant is not active.");
  const ceiling = ceilingFromGrant(source);
  const requestedWorkspace = nextSession.workspacePath;
  if (ceiling.workspaceId !== null && requestedWorkspace !== ceiling.workspaceId) invalid("The root workspace exceeds its construction ceiling.");
  if (input.visibility && input.visibility !== ceiling.visibility) invalid("The root visibility exceeds its construction ceiling.");
  requestedRootCeiling(input, ceiling);
}

export function initializeSessionConstruction(
  db: DatabaseSync,
  input: ConstructionInput,
  proof: MutationAuthorityProof,
  newSession: Session,
  operationId: string,
  now: string,
): void {
  const placement = input.placement;
  const budget = new ResourceBudgetStorage(db);
  if (placement.kind === "root") {
    if (proof.principal.kind === "user" || proof.principal.kind === "system") {
      ensureBaselineSessionAuthority(db, newSession.id, now);
      bootstrapRootResourceBudget(db, { rootSessionId: newSession.id, rootCreatedAt: newSession.updatedAt, createdAt: now });
      if (input.budget.kind === "explicit") {
        const account = budget.getByAccountId(newSession.id);
        budget.configure({ sessionId: newSession.id, accountId: newSession.id, expectedRevision: account.revision,
          hardLimits: input.budget.hardLimits, deadlineAt: input.budget.deadlineAt,
          idempotencyKey: `session-construction:${operationId}` }, proof, now);
      }
      return;
    }
    if (proof.principal.kind !== "agent" || proof.grantId === null || proof.grantRevision === null) invalid("Root construction requires an admitted construction grant.");
    const source = listActiveSessionAuthorityGrants(db, proof.principal.actorSessionId, new Date(now)).find((grant) => grant.grantId === proof.grantId);
    if (!source) invalid("The root construction grant is not active.");
    const ceiling = requestedRootCeiling(input, ceilingFromGrant(source));
    createDerivedRootAuthority(db, {
      sourceRootSessionId: source.rootSessionId,
      sourceGrantId: source.grantId,
      sourceGrantRevision: source.revision,
      operationId,
      targetRootSessionId: newSession.id,
      ceiling,
      createdAt: now,
    });
    bootstrapRootResourceBudget(db, { rootSessionId: newSession.id, rootCreatedAt: newSession.updatedAt, createdAt: now });
    const account = budget.getByAccountId(newSession.id);
    const limits = requestedBudget(input, ceiling);
    const budgetProof: MutationAuthorityProof = { principal: { kind: "system", service: "session-lifecycle" }, providerId: null,
      operation: "budget.configure", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "budget.configure", effectClass: "local_mutation", grantId: null, grantRevision: null,
      resolvedScope: { resourceKind: "budget", resourceId: newSession.id, rootSessionId: newSession.id, ownerKind: "session", ownerId: newSession.id, relation: "self" }, evaluatedAt: now };
    budget.configure({ sessionId: newSession.id, accountId: newSession.id, expectedRevision: account.revision, hardLimits: limits,
      deadlineAt: input.budget.kind === "explicit" ? input.budget.deadlineAt : account.deadlineAt,
      ...(ceiling.expiresAt === null ? {} : { expiresAt: ceiling.expiresAt }), idempotencyKey: `session-construction:${operationId}` }, budgetProof, now);
    budget.consumeCount({ sessionId: source.rootSessionId, dimension: "sessions", idempotencyKey: `session-construction:${operationId}`, consumedAt: now });
    return;
  }
  const parent = binding(db, placement.parentSessionId);
  const parentGrant = listActiveSessionAuthorityGrants(db, placement.parentSessionId, new Date(now)).find((grant) => grant.actions.includes("session.create"));
  if (!parentGrant) invalid("The parent construction grant is not active.");
  createDelegatedChildAuthority(db, { parentProof: proof, childSessionId: newSession.id, operationId, createdAt: now,
    requestedActions: input.initialGrant.kind === "explicit" ? input.initialGrant.actions : undefined,
    requestedExpiresAt: input.initialGrant.kind === "explicit" ? input.initialGrant.expiresAt : undefined });
  if (input.budget.kind === "explicit") {
    const budgetInput = input.budget;
    const parentBudget = budget.get(placement.parentSessionId);
    const hardLimits = Object.fromEntries(RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, budgetInput.hardLimits[dimension] ?? 0])) as ResourceBudgetAmounts;
    budget.consumeCount({ sessionId: placement.parentSessionId, dimension: "sessions", idempotencyKey: `session-construction-count:${operationId}`, consumedAt: now });
    budget.allocateChild({ accountId: newSession.id, accountKind: "session", rootSessionId: parent.root_session_id, ownerSessionId: newSession.id,
      parentAccountId: parentBudget.accountId, hardLimits, authorityGrantId: proof.grantId, authorityGrantRevision: proof.grantRevision,
      expiresAt: input.initialGrant.kind === "explicit" ? input.initialGrant.expiresAt : null, deadlineAt: budgetInput.deadlineAt,
      idempotencyKey: `session-construction:${operationId}`, proof, createdAt: now });
  } else {
    budget.consumeCount({ sessionId: placement.parentSessionId, dimension: "sessions", idempotencyKey: `session-construction:${operationId}`, consumedAt: now });
  }
  void parentGrant;
}
