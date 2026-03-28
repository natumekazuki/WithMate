import type { AuditLogEntry, AuditLogOperation, LiveRunStep, LiveSessionRunState, Session } from "./app-state.js";
import { buildLatestCommandView, type LatestCommandView } from "./session-ui-projection.js";

export type CharacterUpdatePaneTabKey = "latest-command" | "memory-extract";

function updateSessionPriority(status: Session["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "idle":
      return 1;
    case "saved":
      return 2;
    default:
      return 3;
  }
}

function compareUpdateSessionRecency(left: Session, right: Session): number {
  const priorityDiff = updateSessionPriority(left.status) - updateSessionPriority(right.status);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const updatedAtDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff;
  }

  return right.id.localeCompare(left.id);
}

function isCompletedMainAuditPhase(phase: AuditLogEntry["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}

export function selectLatestCharacterUpdateSession(sessions: Session[], characterId: string | null): Session | null {
  if (!characterId) {
    return null;
  }

  const candidates = sessions
    .filter((session) => session.characterId === characterId && session.sessionKind === "character-update")
    .sort(compareUpdateSessionRecency);

  return candidates[0] ?? null;
}

export function selectLatestLiveCommandStep(liveRun: LiveSessionRunState | null): LiveRunStep | null {
  const steps = liveRun?.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.type === "command_execution") {
      return steps[index];
    }
  }

  return null;
}

export function selectLatestMainAuditCommandOperation(auditLogs: AuditLogEntry[]): {
  operation: AuditLogOperation | null;
  phase: AuditLogEntry["phase"] | null;
} {
  for (const entry of auditLogs) {
    if (!isCompletedMainAuditPhase(entry.phase)) {
      continue;
    }

    for (let index = entry.operations.length - 1; index >= 0; index -= 1) {
      if (entry.operations[index]?.type === "command_execution") {
        return {
          operation: entry.operations[index] ?? null,
          phase: entry.phase,
        };
      }
    }
  }

  return {
    operation: null,
    phase: null,
  };
}

export function buildCharacterUpdateLatestCommandView(args: {
  liveRun: LiveSessionRunState | null;
  auditLogs: AuditLogEntry[];
}): LatestCommandView | null {
  const latestLiveCommandStep = selectLatestLiveCommandStep(args.liveRun);
  const latestAuditCommand = selectLatestMainAuditCommandOperation(args.auditLogs);

  return buildLatestCommandView({
    latestLiveCommandStep,
    latestAuditCommandOperation: latestAuditCommand.operation,
    latestTerminalAuditPhase: latestAuditCommand.phase,
  });
}
