import type { SessionSummary } from "./app-state.js";
import type { CompanionSessionSummary } from "./companion-state.js";
import { sessionStateLabel } from "./ui-utils.js";

export type HomeSessionState = {
  kind: "running" | "interrupted" | "error" | "neutral";
  label: string;
};

export type HomeAgentMonitorEntry = {
  kind: "agent";
  session: SessionSummary;
  state: HomeSessionState;
};

export type HomeCompanionMonitorEntry = {
  kind: "companion";
  session: CompanionSessionSummary;
  state: HomeSessionState;
  groupLabel: string;
};

export type HomeMonitorEntry = HomeAgentMonitorEntry | HomeCompanionMonitorEntry;

export type HomeSessionProjection = {
  filteredSessionEntries: HomeAgentMonitorEntry[];
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

export function getHomeCompanionSessionState(session: CompanionSessionSummary): HomeSessionState {
  if (session.runState === "running") {
    return {
      kind: "running",
      label: "実行中",
    };
  }

  if (session.runState === "error" || session.status === "recovery-required") {
    return {
      kind: "error",
      label: session.status === "recovery-required" ? "要復旧" : "エラー",
    };
  }

  if (session.status === "merged") {
    return {
      kind: "neutral",
      label: "merged",
    };
  }

  if (session.status === "discarded") {
    return {
      kind: "neutral",
      label: "discarded",
    };
  }

  return {
    kind: "neutral",
    label: "待機",
  };
}

export function buildCompanionGroupLabel(session: Pick<CompanionSessionSummary, "groupId" | "repoRoot">): string {
  const normalizedRepoRoot = session.repoRoot.replace(/[\\/]+$/, "");
  const pathParts = normalizedRepoRoot.split(/[\\/]/).filter(Boolean);
  return pathParts.at(-1) || session.groupId;
}

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function isWorkspaceInCompanionGroup(workspacePath: string, repoRoot: string): boolean {
  const normalizedWorkspacePath = normalizePathKey(workspacePath);
  const normalizedRepoRoot = normalizePathKey(repoRoot);

  if (!normalizedWorkspacePath || !normalizedRepoRoot) {
    return false;
  }

  return normalizedWorkspacePath === normalizedRepoRoot || normalizedWorkspacePath.startsWith(`${normalizedRepoRoot}/`);
}

export function buildHomeCompanionMonitorEntries(
  companionSessions: readonly CompanionSessionSummary[],
  normalizedSessionSearch = "",
  openCompanionReviewWindowIds: readonly string[] = [],
): HomeCompanionMonitorEntry[] {
  const openCompanionIdSet = new Set(openCompanionReviewWindowIds);
  const openGroupIds = new Set(
    companionSessions
      .filter((session) => openCompanionIdSet.has(session.id))
      .map((session) => session.groupId),
  );

  if (openGroupIds.size === 0) {
    return [];
  }

  return companionSessions
    .filter((session) => openGroupIds.has(session.groupId))
    .filter((session) => {
      if (!normalizedSessionSearch) {
        return true;
      }

      const haystacks = [
        session.taskTitle,
        session.character,
        session.groupId,
        session.repoRoot,
        session.focusPath,
        session.targetBranch,
        session.status,
      ].map((value) => value.toLocaleLowerCase());
      return haystacks.some((value) => value.includes(normalizedSessionSearch));
    })
    .map((session) => ({
      kind: "companion" as const,
      session,
      state: getHomeCompanionSessionState(session),
      groupLabel: buildCompanionGroupLabel(session),
    }));
}

export function buildCompanionGroupMonitorEntries(
  companionSessions: readonly CompanionSessionSummary[],
  openCompanionReviewWindowIds: readonly string[] = [],
): HomeCompanionMonitorEntry[] {
  return buildHomeCompanionMonitorEntries(
    companionSessions,
    "",
    openCompanionReviewWindowIds,
  );
}

export function buildHomeSessionProjection(
  sessions: readonly SessionSummary[],
  openSessionWindowIds: readonly string[],
  sessionSearchText: string,
  companionSessions: readonly CompanionSessionSummary[] = [],
  openCompanionReviewWindowIds: readonly string[] = [],
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
      kind: "agent" as const,
      session,
      state: getHomeSessionState(session),
    }));

  const openSessionWindowIdSet = new Set(openSessionWindowIds);
  const companionMonitorEntries = buildHomeCompanionMonitorEntries(
    companionSessions,
    normalizedSessionSearch,
    openCompanionReviewWindowIds,
  );
  const monitorEntries = [
    ...filteredSessionEntries.filter(({ session }) => openSessionWindowIdSet.has(session.id)),
    ...companionMonitorEntries,
  ].sort((left, right) => {
    const leftTime = Date.parse(left.session.updatedAt);
    const rightTime = Date.parse(right.session.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
  const runningMonitorEntries = monitorEntries.filter(({ state }) => state.kind === "running");
  const nonRunningMonitorEntries = monitorEntries.filter(({ state }) => state.kind !== "running");

  const hasOpenSessionWindows = openSessionWindowIds.length > 0;
  const monitorBaseEmptyMessage =
    filteredSessionEntries.length === 0 && companionMonitorEntries.length === 0
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
