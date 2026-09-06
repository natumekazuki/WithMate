import type { SessionRuntimeOperation } from "./session-external-runtime-contract.js";
import type { SessionRole } from "./session-role-binding.js";

export const SESSION_AUTHORITY_MAPPING_REVISION = 2 as const;

export const SESSION_AUTHORITY_EFFECT_CLASSES = [
  "read",
  "local_mutation",
  "external_side_effect",
] as const;
export type SessionAuthorityEffectClass = (typeof SESSION_AUTHORITY_EFFECT_CLASSES)[number];

export const SESSION_AUTHORITY_DECISION_CLASSES = [
  "agent_delegable",
  "user_only",
  "deny_or_cancel",
] as const;
export type SessionAuthorityDecisionClass = (typeof SESSION_AUTHORITY_DECISION_CLASSES)[number];

export const SESSION_AUTHORITY_RESOURCE_KINDS = [
  "runtime",
  "session",
  "session_namespace",
  "session_files",
  "work_item",
  "execution",
  "interaction",
  "coordination_event",
  "transcript",
  "budget",
] as const;
export type SessionAuthorityResourceKind = (typeof SESSION_AUTHORITY_RESOURCE_KINDS)[number];

export const SESSION_AUTHORITY_RELATION_SELECTORS = [
  "self",
  "parent",
  "direct_child",
  "sibling",
  "root_owner",
  "root_member",
  "owned_root",
  "assigned",
  "created",
  "creator_or_target",
  "visible_root",
] as const;
export type SessionAuthorityRelationSelector = (typeof SESSION_AUTHORITY_RELATION_SELECTORS)[number];

export type SessionAuthorityPrincipal =
  | Readonly<{
      kind: "agent";
      agent: "session-runtime";
      actorSessionId: string;
      runtimeGeneration: string;
    }>
  | Readonly<{ kind: "user"; receiptId: string }>
  | Readonly<{ kind: "system"; service: string }>;

export type SessionAuthorityGrant = Readonly<{
  grantId: string;
  rootSessionId: string;
  issuerKind: SessionAuthorityPrincipal["kind"];
  issuerId: string;
  issuerGrantId: string | null;
  issuerGrantRevision: number | null;
  granteeSessionId: string;
  actions: readonly SessionRuntimeOperation[];
  resourceKind: SessionAuthorityResourceKind;
  relationSelector: SessionAuthorityRelationSelector;
  targetSessionRoles: readonly ("standalone" | "overall-coordinator" | "task-coordinator" | "executor")[];
  effectClass: SessionAuthorityEffectClass;
  delegable: boolean;
  childCeiling: readonly SessionAuthorityPermission[];
  issuedAt: string;
  effectiveAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revision: number;
  mappingRevision: number;
}>;

export type SessionAuthorityPermissionMode = "exercise" | "delegate";

export type SessionAuthorityPermission = Readonly<{
  mode: SessionAuthorityPermissionMode;
  action: SessionRuntimeOperation;
  resourceKind: SessionAuthorityResourceKind;
  relationSelector: SessionAuthorityRelationSelector;
  effectClass: SessionAuthorityEffectClass;
  targetSessionRoles: readonly ("standalone" | "overall-coordinator" | "task-coordinator" | "executor")[];
}>;

export type ResolvedSessionAuthorityScope = Readonly<{
  resourceKind: SessionAuthorityResourceKind;
  resourceId: string | null;
  rootSessionId: string;
  ownerKind: "session";
  ownerId: string;
  relation: SessionAuthorityRelationSelector;
}>;

export type MutationAdmissionProof = Readonly<{
  principal: Extract<SessionAuthorityPrincipal, { kind: "agent" }>;
  providerId: string;
  operation: SessionRuntimeOperation;
  mappingRevision: number;
  action: SessionRuntimeOperation;
  resolvedScope: ResolvedSessionAuthorityScope;
  effectClass: SessionAuthorityEffectClass;
  grantId: string;
  grantRevision: number;
  evaluatedAt: string;
}>;

export type AuthorizedOperation<T = unknown> = Readonly<{
  input: T;
  proof: MutationAdmissionProof;
}>;

export type TrustedMutationProof = Readonly<{
  principal: Extract<SessionAuthorityPrincipal, { kind: "user" | "system" }>;
  providerId?: null;
  operation: SessionRuntimeOperation;
  mappingRevision: number;
  action: SessionRuntimeOperation;
  resolvedScope: ResolvedSessionAuthorityScope;
  effectClass: SessionAuthorityEffectClass;
  grantId: null;
  grantRevision: null;
  evaluatedAt: string;
}>;

export type MutationAuthorityProof = MutationAdmissionProof | TrustedMutationProof;

export function isAgentMutationProof(proof: MutationAuthorityProof): proof is MutationAdmissionProof {
  return proof.principal.kind === "agent";
}

export type ResourceEventHeader = Readonly<{
  eventId: string;
  resourceKind: SessionAuthorityResourceKind;
  resourceId: string;
  rootId: string;
  ownerKind: "session";
  ownerId: string;
  eventKind: string;
  resourceRevision: number | null;
  principalKind: SessionAuthorityPrincipal["kind"];
  actorSessionId: string | null;
  grantId: string | null;
  grantRevision: number | null;
  operationId: string;
  idempotencyKeyFingerprint: string | null;
  occurredAt: string;
  committedAt: string;
  supersedesEventId: string | null;
  payloadSchemaRevision: number;
  effect: "none" | "committed" | "unknown";
}>;

type AuthorityScopeSource =
  | "actor"
  | "session"
  | "target_session"
  | "work_item"
  | "parent_work_item"
  | "execution"
  | "interaction"
  | "coordination_event"
  | "coordination_list";

export type AuthorityOperationDefinition = Readonly<{
  action: SessionRuntimeOperation;
  resourceKind: SessionAuthorityResourceKind;
  scopeSource: AuthorityScopeSource;
  effectClass: SessionAuthorityEffectClass;
  decisionClass: SessionAuthorityDecisionClass;
}>;

export type SessionAuthorityGrantTemplate = Readonly<{
  resourceKind: SessionAuthorityResourceKind;
  relationSelector: SessionAuthorityRelationSelector;
  targetSessionRoles: readonly SessionRole[];
  effectClass: SessionAuthorityEffectClass;
  delegable: boolean;
  actions: readonly SessionRuntimeOperation[];
}>;

const definition = <T extends SessionRuntimeOperation>(
  action: T,
  resourceKind: SessionAuthorityResourceKind,
  scopeSource: AuthorityScopeSource,
  effectClass: SessionAuthorityEffectClass,
  decisionClass: SessionAuthorityDecisionClass = "agent_delegable",
): AuthorityOperationDefinition => ({ action, resourceKind, scopeSource, effectClass, decisionClass });

export const SESSION_AUTHORITY_OPERATION_DEFINITIONS = {
  "budget.get": definition("budget.get", "budget", "session", "read"),
  "budget.list": definition("budget.list", "budget", "session", "read"),
  "budget.configure": definition("budget.configure", "budget", "session", "local_mutation"),
  "runtime.catalog": definition("runtime.catalog", "runtime", "actor", "read"),
  "session.self": definition("session.self", "session", "actor", "read"),
  "session.create": definition("session.create", "session_namespace", "actor", "local_mutation"),
  "session.list": definition("session.list", "session", "actor", "read"),
  "session.get": definition("session.get", "session", "session", "read"),
  "session.rename": definition("session.rename", "session", "session", "local_mutation"),
  "session.files.list": definition("session.files.list", "session_files", "session", "read"),
  "session.files.read_text": definition("session.files.read_text", "session_files", "session", "read"),
  "session.files.write_text": definition("session.files.write_text", "session_files", "session", "external_side_effect"),
  "work.create": definition("work.create", "work_item", "target_session", "local_mutation"),
  "work.list": definition("work.list", "work_item", "actor", "read"),
  "work.get": definition("work.get", "work_item", "work_item", "read"),
  "work.revise": definition("work.revise", "work_item", "work_item", "local_mutation"),
  "work.history.append": definition("work.history.append", "work_item", "work_item", "local_mutation"),
  "work.history.list": definition("work.history.list", "work_item", "work_item", "read"),
  "work.transition": definition("work.transition", "work_item", "work_item", "local_mutation"),
  "work.result": definition("work.result", "work_item", "work_item", "local_mutation"),
  "work.cancel": definition("work.cancel", "work_item", "work_item", "local_mutation"),
  "work.aggregation.get": definition("work.aggregation.get", "work_item", "parent_work_item", "read"),
  "work.aggregation.list": definition("work.aggregation.list", "work_item", "parent_work_item", "read"),
  "work.aggregation.decide": definition("work.aggregation.decide", "work_item", "parent_work_item", "local_mutation"),
  "work.aggregation.retry": definition("work.aggregation.retry", "work_item", "parent_work_item", "local_mutation"),
  "turn.options": definition("turn.options", "session", "session", "read"),
  "turn.run": definition("turn.run", "execution", "session", "external_side_effect"),
  "turn.enqueue": definition("turn.enqueue", "execution", "session", "external_side_effect"),
  "turn.list": definition("turn.list", "execution", "session", "read"),
  "turn.get": definition("turn.get", "execution", "execution", "read"),
  "turn.cancel": definition("turn.cancel", "execution", "execution", "external_side_effect"),
  "interaction.list": definition("interaction.list", "interaction", "session", "read"),
  "interaction.respond": definition("interaction.respond", "interaction", "interaction", "external_side_effect"),
  "coordination.event.create": definition("coordination.event.create", "coordination_event", "actor", "local_mutation"),
  "coordination.event.list": definition("coordination.event.list", "coordination_event", "coordination_list", "read"),
  "coordination.event.get": definition("coordination.event.get", "coordination_event", "coordination_event", "read"),
  "coordination.event.resolve": definition("coordination.event.resolve", "coordination_event", "coordination_event", "local_mutation"),
  "coordination.event.consume": definition("coordination.event.consume", "coordination_event", "coordination_event", "local_mutation"),
  "coordination.event.cancel": definition("coordination.event.cancel", "coordination_event", "coordination_event", "local_mutation"),
  "coordination.event.correct": definition("coordination.event.correct", "coordination_event", "coordination_event", "local_mutation"),
  "transcript.export": definition("transcript.export", "transcript", "session", "external_side_effect"),
} as const satisfies Record<SessionRuntimeOperation, AuthorityOperationDefinition>;

export function verifySessionAuthorityOperationDefinitions(
  operations: readonly SessionRuntimeOperation[],
): void {
  const registered = new Set(Object.keys(SESSION_AUTHORITY_OPERATION_DEFINITIONS));
  const missing = operations.filter((operation) => !registered.has(operation));
  const unexpected = [...registered].filter((operation) => !operations.includes(operation as SessionRuntimeOperation));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Session authority operation mapping is incomplete (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`);
  }
}

export class SessionAuthorityError extends Error {
  constructor(
    readonly code:
      | "AUTHORITY_FORBIDDEN"
      | "AUTHORITY_GRANT_EXPIRED"
      | "AUTHORITY_GRANT_REVOKED"
      | "AUTHORITY_GRANT_REVISION_CONFLICT"
      | "AUTHORITY_SCOPE_INVALID"
      | "AUTHORITY_MIGRATION_REQUIRED",
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "SessionAuthorityError";
  }
}
