type AuditLogOwnerSession = { id: string } | null;

type ResolveAuditLogOwnerInput<TSession extends AuditLogOwnerSession> = {
  parentSession: TSession;
  displayedSession: TSession;
  hasActiveAuxiliarySession: boolean;
  parentSourceLabel: string;
};

type AuditLogOwnerProjection<TSession extends AuditLogOwnerSession> = {
  session: TSession;
  ownerSessionId: string | null;
  sourceLabel: string;
};

export function resolveAuditLogOwner<TSession extends AuditLogOwnerSession>({
  parentSession,
  displayedSession,
  hasActiveAuxiliarySession,
  parentSourceLabel,
}: ResolveAuditLogOwnerInput<TSession>): AuditLogOwnerProjection<TSession> {
  const session = hasActiveAuxiliarySession ? displayedSession : parentSession;
  return {
    session,
    ownerSessionId: session?.id ?? null,
    sourceLabel: hasActiveAuxiliarySession ? "Auxiliary Session" : parentSourceLabel,
  };
}
