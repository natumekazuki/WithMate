type AuditLogOwnerSession = { id: string } | null;

type ResolveAuditLogOwnerInput<TSession extends AuditLogOwnerSession> = {
  parentSession: TSession;
  displayedSession: TSession;
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
  parentSourceLabel,
}: ResolveAuditLogOwnerInput<TSession>): AuditLogOwnerProjection<TSession> {
  return {
    session: displayedSession,
    ownerSessionId: parentSession?.id ?? displayedSession?.id ?? null,
    sourceLabel: parentSourceLabel,
  };
}
