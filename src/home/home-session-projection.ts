import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { sessionStatusLabel } from "../ui/ui-utils.js";

export type HomeSessionState = { kind: "approval" | "running" | "error" | "neutral"; label: string };
export const HOME_SESSION_FAILURE_STATE = { kind: "error", label: "Failed" } as const;
export type HomeMonitorAuxiliaryDataState = "loading" | "ready" | "error";
export type HomeAgentMonitorEntry = { kind: "agent"; session: HomeSessionSummary; state: HomeSessionState; mainState: HomeSessionState; auxiliarySessions: AuxiliarySessionSummary[] };
export type HomeMonitorEntry = HomeAgentMonitorEntry;
export type HomeSessionProjection = { filteredSessionEntries: HomeAgentMonitorEntry[]; normalizedSessionSearch: string; monitorEntries: HomeMonitorEntry[]; approvalMonitorEntries: HomeMonitorEntry[]; runningMonitorEntries: HomeMonitorEntry[]; nonRunningMonitorEntries: HomeMonitorEntry[]; monitorBaseEmptyMessage: string; monitorRunningEmptyMessage: string; monitorCompletedEmptyMessage: string };

export function getHomeSessionKindSearchLabels(session: HomeSessionSummary): string[] {
  return session.sessionKind === "character-authoring" ? ["character", "character authoring", "authoring", "agent"] : ["agent", session.sessionKind];
}
export function getHomeSessionState(session: HomeSessionSummary, auxiliarySessions: readonly AuxiliarySessionSummary[] | AuxiliarySessionSummary | null = []): HomeSessionState {
  const auxiliaries = !auxiliarySessions ? [] : Array.isArray(auxiliarySessions) ? auxiliarySessions : [auxiliarySessions];
  if ([session, ...auxiliaries].some((item) => item.approvalPending && !item.cancellationState)) return { kind: "approval", label: "Attention" };
  const cancellationStates = [session.cancellationState, ...auxiliaries.map((item) => item.cancellationState)];
  if (cancellationStates.includes("terminating")) return { kind: "running", label: "Waiting For Stop" };
  if (cancellationStates.includes("requested")) return { kind: "running", label: "Canceling" };
  if (session.status === "running" || session.runState === "running" || auxiliaries.some((item) => item.runState === "running")) return { kind: "running", label: "Running" };
  if (session.runState === "interrupted" || session.runState === "error") return HOME_SESSION_FAILURE_STATE;
  if (session.runState && session.runState !== "idle") return { kind: "neutral", label: "Unknown" };
  return { kind: "neutral", label: sessionStatusLabel(session.status) };
}
export function getHomeAuxiliarySessionState(summary: AuxiliarySessionSummary): HomeSessionState {
  if (summary.cancellationState === "terminating") return { kind: "running", label: "Waiting For Stop" };
  if (summary.cancellationState === "requested") return { kind: "running", label: "Canceling" };
  if (summary.approvalPending) return { kind: "approval", label: "Attention" };
  if (summary.runState === "running") return { kind: "running", label: "Running" };
  if (summary.runState === "error") return HOME_SESSION_FAILURE_STATE;
  return { kind: "neutral", label: "Idle" };
}
export function sortAuxiliarySessions(sessions: readonly AuxiliarySessionSummary[]): AuxiliarySessionSummary[] {
  const isActive = (session: AuxiliarySessionSummary) => ["running", "approval"].includes(getHomeAuxiliarySessionState(session).kind);
  return [...sessions].sort((left, right) => Number(isActive(right)) - Number(isActive(left)) || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}
export function buildHomeSessionProjection(sessions: readonly HomeSessionSummary[], monitorSessionIds: readonly string[], sessionSearchText: string, auxiliarySessionSummaries: readonly AuxiliarySessionSummary[] = [], pageSessionIds?: ReadonlySet<string>): HomeSessionProjection {
  const normalizedSessionSearch = sessionSearchText.trim().toLocaleLowerCase();
  const byParent = new Map<string, AuxiliarySessionSummary[]>();
  for (const auxiliary of auxiliarySessionSummaries) byParent.set(auxiliary.parentSessionId, [...(byParent.get(auxiliary.parentSessionId) ?? []), auxiliary]);
  for (const [id, auxiliaries] of byParent) byParent.set(id, sortAuxiliarySessions(auxiliaries));
  const matchesSearch = (session: HomeSessionSummary) => {
    if (!normalizedSessionSearch) return true;
    return [session.taskTitle, session.workspacePath, session.workspaceLabel, session.character, ...getHomeSessionKindSearchLabels(session)].map((value) => value.toLocaleLowerCase()).some((value) => value.includes(normalizedSessionSearch));
  };
  // ページに含める対象はバックエンドで絞り込み済み。次の結果が届くまで保持する。
  const filteredSessionEntries = sessions.filter((session) => pageSessionIds?.has(session.id) || matchesSearch(session))
    .map((session) => { const auxiliarySessions = [...(byParent.get(session.id) ?? [])]; return { kind: "agent" as const, session, state: getHomeSessionState(session, auxiliarySessions), mainState: getHomeSessionState(session), auxiliarySessions }; });
  const monitorIds = new Set(monitorSessionIds);
  const monitorEntries = filteredSessionEntries.filter(({ session }) => monitorIds.has(session.id) && matchesSearch(session));
  const approvalMonitorEntries = monitorEntries.filter(({ state }) => state.kind === "approval");
  const runningMonitorEntries = monitorEntries.filter(({ state }) => state.kind === "running");
  const nonRunningMonitorEntries = monitorEntries.filter(({ state }) => state.kind !== "running" && state.kind !== "approval");
  const monitorBaseEmptyMessage = "";
  return {
    filteredSessionEntries,
    normalizedSessionSearch,
    monitorEntries,
    approvalMonitorEntries,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    monitorBaseEmptyMessage,
    monitorRunningEmptyMessage: monitorBaseEmptyMessage,
    monitorCompletedEmptyMessage: monitorBaseEmptyMessage,
  };
}
