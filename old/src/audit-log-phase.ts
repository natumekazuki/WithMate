import type { AuditLogSummary } from "./runtime-state.js";

const terminalAuditLogPhases: readonly AuditLogSummary["phase"][] = [
  "completed",
  "failed",
  "canceled",
  "background-completed",
  "background-failed",
  "background-canceled",
];

export function isTerminalAuditLogPhase(phase: AuditLogSummary["phase"]): boolean {
  return terminalAuditLogPhases.includes(phase);
}
