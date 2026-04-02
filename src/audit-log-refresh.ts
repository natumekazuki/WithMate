import type { Session } from "./session-state.js";
import type { SessionBackgroundActivityState } from "./memory-state.js";

type AuditLogRefreshActivity = Pick<SessionBackgroundActivityState, "kind" | "status" | "updatedAt"> | null | undefined;

type BuildAuditLogRefreshSignatureInput = {
  selectedSession: Pick<Session, "id" | "runState" | "updatedAt"> | null;
  displayedMessagesLength: number;
  selectedMemoryGenerationActivity?: AuditLogRefreshActivity;
  selectedCharacterMemoryGenerationActivity?: AuditLogRefreshActivity;
  selectedMonologueActivity?: AuditLogRefreshActivity;
};

function serializeBackgroundActivity(activity: AuditLogRefreshActivity): string {
  if (!activity) {
    return "none";
  }

  return `${activity.kind}:${activity.status}:${activity.updatedAt}`;
}

export function buildAuditLogRefreshSignature(input: BuildAuditLogRefreshSignatureInput): string {
  if (!input.selectedSession) {
    return "no-session";
  }

  return [
    input.selectedSession.id,
    input.displayedMessagesLength,
    input.selectedSession.runState,
    input.selectedSession.updatedAt,
    serializeBackgroundActivity(input.selectedMemoryGenerationActivity),
    serializeBackgroundActivity(input.selectedCharacterMemoryGenerationActivity),
    serializeBackgroundActivity(input.selectedMonologueActivity),
  ].join("|");
}
