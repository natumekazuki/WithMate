export const SESSION_ROLE_CONTRACT_REVISION = 1 as const;
export const SESSION_ROLE_MAX_DELEGATION_DEPTH = 2 as const;

export const SESSION_ROLE_VALUES = [
  "standalone",
  "overall-coordinator",
  "task-coordinator",
  "executor",
] as const;

export type SessionRole = (typeof SESSION_ROLE_VALUES)[number];
export type RootSessionRole = Extract<SessionRole, "standalone" | "overall-coordinator">;
export type ChildSessionRole = Extract<SessionRole, "task-coordinator" | "executor">;

export type SessionRoleBinding = Readonly<{
  sessionRole: SessionRole;
  roleContractRevision: typeof SESSION_ROLE_CONTRACT_REVISION;
  rootSessionId: string;
  parentSessionId: string | null;
  delegationDepth: number;
}>;

export const SESSION_ROLE_CHILDREN = {
  standalone: [],
  "overall-coordinator": ["task-coordinator", "executor"],
  "task-coordinator": ["executor"],
  executor: [],
} as const satisfies Record<SessionRole, readonly ChildSessionRole[]>;

export class SessionRoleBindingError extends Error {
  constructor(
    readonly code:
      | "SESSION_ROLE_UNSUPPORTED"
      | "SESSION_ROLE_BINDING_INVALID"
      | "SESSION_ROLE_FORBIDDEN"
      | "SESSION_ROLE_DEPTH_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "SessionRoleBindingError";
  }
}

export function buildRootSessionRoleBinding(
  sessionId: string,
  sessionRole: RootSessionRole,
): SessionRoleBinding {
  return requireSessionRoleBinding(sessionId, {
    sessionRole,
    roleContractRevision: SESSION_ROLE_CONTRACT_REVISION,
    rootSessionId: sessionId,
    parentSessionId: null,
    delegationDepth: 0,
  });
}

export function buildChildSessionRoleBinding(
  sessionId: string,
  parentSessionId: string,
  parentBinding: SessionRoleBinding,
  sessionRole: ChildSessionRole,
): SessionRoleBinding {
  const normalizedParentSessionId = parentSessionId.trim();
  const canonicalParentBinding = requireSessionRoleBinding(normalizedParentSessionId, parentBinding);
  const delegationDepth = requireChildSessionRoleAllowed(canonicalParentBinding, sessionRole);
  return requireSessionRoleBinding(sessionId, {
    sessionRole,
    roleContractRevision: SESSION_ROLE_CONTRACT_REVISION,
    rootSessionId: canonicalParentBinding.rootSessionId,
    parentSessionId: normalizedParentSessionId,
    delegationDepth,
  });
}

export function requireChildSessionRoleAllowed(
  parentBinding: SessionRoleBinding,
  sessionRole: ChildSessionRole,
): number {
  if (!SESSION_ROLE_CHILDREN[parentBinding.sessionRole].includes(sessionRole as never)) {
    throw new SessionRoleBindingError(
      "SESSION_ROLE_FORBIDDEN",
      `${parentBinding.sessionRole} cannot create a ${sessionRole} child Session.`,
    );
  }
  const delegationDepth = parentBinding.delegationDepth + 1;
  if (delegationDepth > SESSION_ROLE_MAX_DELEGATION_DEPTH) {
    throw new SessionRoleBindingError(
      "SESSION_ROLE_DEPTH_EXCEEDED",
      `Session delegation depth cannot exceed ${SESSION_ROLE_MAX_DELEGATION_DEPTH}.`,
    );
  }
  return delegationDepth;
}

export function requireSessionRoleBinding(
  sessionId: string,
  value: unknown,
): SessionRoleBinding {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId || !value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBinding();
  }
  const candidate = value as Partial<Record<keyof SessionRoleBinding, unknown>>;
  if (typeof candidate.sessionRole !== "string" || !SESSION_ROLE_VALUES.includes(candidate.sessionRole as SessionRole)) {
    throw new SessionRoleBindingError("SESSION_ROLE_UNSUPPORTED", "Session Role is unsupported.");
  }
  if (candidate.roleContractRevision !== SESSION_ROLE_CONTRACT_REVISION) {
    throw new SessionRoleBindingError("SESSION_ROLE_BINDING_INVALID", "Session Role contract revision is unsupported.");
  }
  const rootSessionId = typeof candidate.rootSessionId === "string" ? candidate.rootSessionId.trim() : "";
  const parentSessionId = candidate.parentSessionId === null
    ? null
    : typeof candidate.parentSessionId === "string"
      ? candidate.parentSessionId.trim()
      : "";
  const delegationDepth = candidate.delegationDepth;
  if (
    !rootSessionId
    || parentSessionId === ""
    || !Number.isSafeInteger(delegationDepth)
    || (delegationDepth as number) < 0
    || (delegationDepth as number) > SESSION_ROLE_MAX_DELEGATION_DEPTH
  ) {
    throw invalidBinding();
  }

  const sessionRole = candidate.sessionRole as SessionRole;
  const isRootRole = sessionRole === "standalone" || sessionRole === "overall-coordinator";
  const isRootTuple = parentSessionId === null
    && rootSessionId === normalizedSessionId
    && delegationDepth === 0;
  const isChildTuple = parentSessionId !== null
    && parentSessionId !== normalizedSessionId
    && rootSessionId !== normalizedSessionId
    && delegationDepth !== 0;
  if (isRootRole !== isRootTuple || (!isRootRole && !isChildTuple)) {
    throw invalidBinding();
  }
  if (sessionRole === "task-coordinator" && delegationDepth !== 1) {
    throw invalidBinding();
  }

  return Object.freeze({
    sessionRole,
    roleContractRevision: SESSION_ROLE_CONTRACT_REVISION,
    rootSessionId,
    parentSessionId,
    delegationDepth: delegationDepth as number,
  });
}

export function sameSessionRoleBinding(
  left: SessionRoleBinding,
  right: SessionRoleBinding,
): boolean {
  return left.sessionRole === right.sessionRole
    && left.roleContractRevision === right.roleContractRevision
    && left.rootSessionId === right.rootSessionId
    && left.parentSessionId === right.parentSessionId
    && left.delegationDepth === right.delegationDepth;
}

function invalidBinding(): SessionRoleBindingError {
  return new SessionRoleBindingError("SESSION_ROLE_BINDING_INVALID", "Session Role binding tuple is invalid.");
}
