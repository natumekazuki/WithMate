import type { SessionSummary } from "./app-state.js";
import { sessionStateLabel } from "./ui-utils.js";

export type HomeSessionState = {
  kind: "running" | "interrupted" | "error" | "neutral";
  label: string;
};

export type HomeMonitorEntry = {
  session: SessionSummary;
  state: HomeSessionState;
};

export type HomeSessionProjection = {
  filteredSessionEntries: HomeMonitorEntry[];
  normalizedSessionSearch: string;
  monitorEntries: HomeMonitorEntry[];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorBaseEmptyMessage: string;
  monitorRunningEmptyMessage: string;
  monitorCompletedEmptyMessage: string;
};

export function shouldDisplayHomeSession(session: SessionSummary): boolean {
  return session.sessionKind !== "character-update";
}

export function getHomeSessionState(session: SessionSummary): HomeSessionState {
  if (session.status === "running" || session.runState === "running") {
    return {
      kind: "running",
      label: "実行中",
    };
  }

  if (session.runState === "interrupted") {
    return {
      kind: "interrupted",
      label: "中断",
    };
  }

  if (session.runState === "error") {
    return {
      kind: "error",
      label: "エラー",
    };
  }

  if (session.runState && session.runState !== "idle") {
    return {
      kind: "neutral",
      label: session.runState,
    };
  }

  return {
    kind: "neutral",
    label: sessionStateLabel(session),
  };
}

export function buildHomeSessionProjection(
  sessions: readonly SessionSummary[],
  openSessionWindowIds: readonly string[],
  sessionSearchText: string,
): HomeSessionProjection {
  const normalizedSessionSearch = sessionSearchText.trim().toLocaleLowerCase();
  const filteredSessionEntries = sessions
    .filter((session) => shouldDisplayHomeSession(session))
    .filter((session) => {
      if (!normalizedSessionSearch) {
        return true;
      }

      const haystacks = [session.taskTitle, session.workspacePath, session.workspaceLabel]
        .map((value) => value.toLocaleLowerCase());
      return haystacks.some((value) => value.includes(normalizedSessionSearch));
    })
    .map((session) => ({
      session,
      state: getHomeSessionState(session),
    }));

  const openSessionWindowIdSet = new Set(openSessionWindowIds);
  const monitorEntries = filteredSessionEntries.filter(({ session }) => openSessionWindowIdSet.has(session.id));
  const runningMonitorEntries = monitorEntries.filter(({ state }) => state.kind === "running");
  const nonRunningMonitorEntries = monitorEntries.filter(({ state }) => state.kind !== "running");

  const hasOpenSessionWindows = openSessionWindowIds.length > 0;
  const monitorBaseEmptyMessage =
    filteredSessionEntries.length === 0
      ? normalizedSessionSearch
        ? "一致するセッションはないよ。"
        : "表示できるセッションはまだないよ。"
      : hasOpenSessionWindows
        ? "一致する開いているセッションはないよ。"
        : "開いているセッションはないよ。";

  return {
    filteredSessionEntries,
    normalizedSessionSearch,
    monitorEntries,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    monitorBaseEmptyMessage,
    monitorRunningEmptyMessage: monitorEntries.length > 0 ? "実行中はないよ。" : monitorBaseEmptyMessage,
    monitorCompletedEmptyMessage: monitorEntries.length > 0 ? "停止・完了はないよ。" : monitorBaseEmptyMessage,
  };
}
