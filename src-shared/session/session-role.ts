export const SESSION_ROLE_VALUES = ["standalone", "overall-coordinator", "task-coordinator", "executor"] as const;
export type SessionRole = typeof SESSION_ROLE_VALUES[number];
export type RelatedSessionRole = SessionRole | "auxiliary";

export type SessionRelationship = {
  sessionRole: SessionRole;
  rootSessionId: string;
  parentSessionId: string | null;
  createdBySessionId: string | null;
};

export function normalizeSessionRelationship(input: Partial<SessionRelationship> & { id: string }): SessionRelationship {
  if (input.sessionRole !== undefined) assertSessionRole(input.sessionRole);
  return {
    sessionRole: input.sessionRole ?? "standalone",
    rootSessionId: input.parentSessionId ? input.rootSessionId?.trim() || input.id : input.id,
    parentSessionId: input.parentSessionId?.trim() || null,
    createdBySessionId: input.createdBySessionId?.trim() || null,
  };
}

export function assertSameSessionRelationship(current: Partial<SessionRelationship> & { id: string }, next: Partial<SessionRelationship> & { id: string }): void {
  const before = normalizeSessionRelationship(current);
  const after = normalizeSessionRelationship(next);
  if (before.sessionRole !== after.sessionRole || before.rootSessionId !== after.rootSessionId
    || before.parentSessionId !== after.parentSessionId || before.createdBySessionId !== after.createdBySessionId) {
    throw new Error("Session Role and saved relationships cannot be changed by a general update.");
  }
}

export function assertChildSessionRole(parentRole: SessionRole, childRole: SessionRole): void {
  if ((parentRole === "overall-coordinator" && (childRole === "task-coordinator" || childRole === "executor"))
    || (parentRole === "task-coordinator" && childRole === "executor")) return;
  throw new Error("This Role cannot create the requested child Session Role.");
}

export function assertSessionRole(value: unknown): asserts value is SessionRole {
  if (!SESSION_ROLE_VALUES.includes(value as SessionRole)) throw new Error("Invalid Session Role.");
}
