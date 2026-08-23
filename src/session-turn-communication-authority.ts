import type { SessionRoleBinding } from "./session-role-binding.js";

export const SESSION_TURN_COMMUNICATION_CONTRACT_REVISION = 1 as const;

export type SessionTurnCommunicationPrincipal = SessionRoleBinding & {
  sessionId: string;
};

export type SessionTurnAuthoritySession = SessionTurnCommunicationPrincipal & {
  title: string;
};

export function canSendSessionTurn(
  actor: SessionTurnCommunicationPrincipal,
  target: SessionTurnCommunicationPrincipal,
): boolean {
  if (actor.sessionId === target.sessionId) return true;
  if (actor.rootSessionId !== target.rootSessionId) return false;

  switch (actor.sessionRole) {
    case "standalone":
      return false;
    case "overall-coordinator":
      return target.parentSessionId === actor.sessionId
        && (target.sessionRole === "task-coordinator" || target.sessionRole === "executor");
    case "task-coordinator":
      return (
        target.sessionRole === "executor"
        && target.parentSessionId === actor.sessionId
      ) || (
        target.sessionRole === "overall-coordinator"
        && target.sessionId === actor.rootSessionId
      ) || (
        target.sessionRole === "task-coordinator"
        && target.parentSessionId === actor.parentSessionId
      );
    case "executor":
      return target.sessionId === actor.parentSessionId
        && (target.sessionRole === "overall-coordinator" || target.sessionRole === "task-coordinator");
  }
}
