import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { sessionStateLabel } from "../ui-utils.js";

export type HomeSessionState = { kind: "running" | "interrupted" | "error" | "neutral"; label: string };
export type HomeMonitorAuxiliaryDataState = "loading" | "ready" | "error";
export type HomeAgentMonitorEntry = { kind: "agent"; session: HomeSessionSummary; state: HomeSessionState; mainState: HomeSessionState; auxiliarySessions: AuxiliarySessionSummary[] };
export type HomeMonitorEntry = HomeAgentMonitorEntry;
export type HomeSessionProjection = { filteredSessionEntries: HomeAgentMonitorEntry[]; normalizedSessionSearch: string; monitorEntries: HomeMonitorEntry[]; runningMonitorEntries: HomeMonitorEntry[]; nonRunningMonitorEntries: HomeMonitorEntry[]; monitorBaseEmptyMessage: string; monitorRunningEmptyMessage: string; monitorCompletedEmptyMessage: string };

export function getHomeSessionKindSearchLabels(session: HomeSessionSummary): string[] {
  return session.sessionKind === "character-authoring" ? ["character", "character authoring", "authoring", "agent"] : ["agent", session.sessionKind];
}
export function getHomeSessionState(session: HomeSessionSummary, auxiliarySessions: readonly AuxiliarySessionSummary[] | AuxiliarySessionSummary | null = []): HomeSessionState {
  const auxiliaries = !auxiliarySessions ? [] : Array.isArray(auxiliarySessions) ? auxiliarySessions : [auxiliarySessions];
  if (session.status === "running" || session.runState === "running" || auxiliaries.some((item) => item.runState === "running")) return { kind: "running", label: "実行中" };
  if (session.runState === "interrupted") return { kind: "interrupted", label: "中断" };
  if (session.runState === "error") return { kind: "error", label: "エラー" };
  if (session.runState && session.runState !== "idle") return { kind: "neutral", label: session.runState };
  return { kind: "neutral", label: sessionStateLabel(session) };
}
function sortAuxiliarySessions(sessions: readonly AuxiliarySessionSummary[]): AuxiliarySessionSummary[] {
  return [...sessions].sort((left, right) => Number(right.runState === "running") - Number(left.runState === "running") || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}
export function buildHomeSessionProjection(sessions: readonly HomeSessionSummary[], openSessionWindowIds: readonly string[], sessionSearchText: string, auxiliarySessionSummaries: readonly AuxiliarySessionSummary[] = []): HomeSessionProjection {
  const normalizedSessionSearch = sessionSearchText.trim().toLocaleLowerCase();
  const byParent = new Map<string, AuxiliarySessionSummary[]>();
  for (const auxiliary of auxiliarySessionSummaries) byParent.set(auxiliary.parentSessionId, [...(byParent.get(auxiliary.parentSessionId) ?? []), auxiliary]);
  for (const [id, auxiliaries] of byParent) byParent.set(id, sortAuxiliarySessions(auxiliaries));
  const filteredSessionEntries = sessions.filter((session) => {
    if (!normalizedSessionSearch) return true;
    return [session.taskTitle, session.workspacePath, session.workspaceLabel, ...getHomeSessionKindSearchLabels(session)].map((value) => value.toLocaleLowerCase()).some((value) => value.includes(normalizedSessionSearch));
  }).map((session) => { const auxiliarySessions = [...(byParent.get(session.id) ?? [])]; return { kind: "agent" as const, session, state: getHomeSessionState(session, auxiliarySessions), mainState: getHomeSessionState(session), auxiliarySessions }; });
  const openIds = new Set(openSessionWindowIds);
  const monitorEntries = filteredSessionEntries.filter(({ session }) => openIds.has(session.id));
  const runningMonitorEntries = monitorEntries.filter(({ state }) => state.kind === "running");
  const nonRunningMonitorEntries = monitorEntries.filter(({ state }) => state.kind !== "running");
  const monitorBaseEmptyMessage = filteredSessionEntries.length === 0 ? (normalizedSessionSearch ? "一致するセッションはないよ。" : "表示できるセッションはまだないよ。") : openSessionWindowIds.length > 0 ? "一致する開いているセッションはないよ。" : "開いているセッションはないよ。";
  return { filteredSessionEntries, normalizedSessionSearch, monitorEntries, runningMonitorEntries, nonRunningMonitorEntries, monitorBaseEmptyMessage, monitorRunningEmptyMessage: monitorEntries.length > 0 ? "実行中はないよ。" : monitorBaseEmptyMessage, monitorCompletedEmptyMessage: monitorEntries.length > 0 ? "停止・完了はないよ。" : monitorBaseEmptyMessage };
}
