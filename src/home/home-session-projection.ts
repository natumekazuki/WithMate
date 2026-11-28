import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { sessionStatusLabel } from "../ui/ui-utils.js";

/** Monitor の分類に使う種別と、個別の状態を表示するラベル。 */
export type HomeSessionState = {
  kind: "approval" | "running" | "error" | "neutral";
  label: string;
};
/** Main の中断・失敗と Auxiliary の失敗に共通で表示する状態。 */
export const HOME_SESSION_FAILURE_STATE = {
  kind: "error",
  label: "Failed",
} as const;
/** Monitor に表示する Auxiliary 要約の取得状態。取得前と失敗を空の結果と区別する。 */
export type HomeMonitorAuxiliaryDataState = "loading" | "ready" | "error";
/** Main 単独の状態と Auxiliary を含む集約状態を区別した Monitor の行。 */
export type HomeAgentMonitorEntry = {
  kind: "agent";
  session: HomeSessionSummary;
  state: HomeSessionState;
  mainState: HomeSessionState;
  auxiliarySessions: AuxiliarySessionSummary[];
};
/** Monitor の各一覧に載せる Agent Session の表示行。 */
export type HomeMonitorEntry = HomeAgentMonitorEntry;
/** 最近の一覧と監視対象を分け、Monitor には対応待ち・実行中・その他の分類も持たせる。 */
export type HomeSessionProjection = {
  filteredSessionEntries: HomeAgentMonitorEntry[];
  normalizedSessionSearch: string;
  monitorEntries: HomeMonitorEntry[];
  approvalMonitorEntries: HomeMonitorEntry[];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorBaseEmptyMessage: string;
  monitorRunningEmptyMessage: string;
  monitorCompletedEmptyMessage: string;
};

/** Session 種別で探せるよう、Character 作成支援には表示名の別表現も検索語として加える。 */
export function getHomeSessionKindSearchLabels(
  session: HomeSessionSummary,
): string[] {
  return session.sessionKind === "character-authoring"
    ? ["character", "character authoring", "authoring", "agent"]
    : ["agent", session.sessionKind];
}
/** 取消中でない対応待ち、停止処理、実行中を優先し、それらがなければ Main の保存状態を表示する。 */
export function getHomeSessionState(
  session: HomeSessionSummary,
  auxiliarySessions:
    readonly AuxiliarySessionSummary[] | AuxiliarySessionSummary | null = [],
): HomeSessionState {
  const auxiliaries = !auxiliarySessions
    ? []
    : Array.isArray(auxiliarySessions)
      ? auxiliarySessions
      : [auxiliarySessions];
  if (
    [session, ...auxiliaries].some(
      (item) => item.approvalPending && !item.cancellationState,
    )
  )
    return { kind: "approval", label: "Attention" };
  const cancellationStates = [
    session.cancellationState,
    ...auxiliaries.map((item) => item.cancellationState),
  ];
  if (cancellationStates.includes("terminating"))
    return { kind: "running", label: "Waiting For Stop" };
  if (cancellationStates.includes("requested"))
    return { kind: "running", label: "Canceling" };
  if (
    session.status === "running" ||
    session.runState === "running" ||
    auxiliaries.some((item) => item.runState === "running")
  )
    return { kind: "running", label: "Running" };
  if (session.runState === "interrupted" || session.runState === "error")
    return HOME_SESSION_FAILURE_STATE;
  if (session.runState && session.runState !== "idle")
    return { kind: "neutral", label: "Unknown" };
  return { kind: "neutral", label: sessionStatusLabel(session.status) };
}
/** Auxiliary の停止処理を先に判定し、続けて対応待ち・実行・失敗・待機を区別する。 */
export function getHomeAuxiliarySessionState(
  summary: AuxiliarySessionSummary,
): HomeSessionState {
  if (summary.cancellationState === "terminating")
    return { kind: "running", label: "Waiting For Stop" };
  if (summary.cancellationState === "requested")
    return { kind: "running", label: "Canceling" };
  if (summary.approvalPending) return { kind: "approval", label: "Attention" };
  if (summary.runState === "running")
    return { kind: "running", label: "Running" };
  if (summary.runState === "error") return HOME_SESSION_FAILURE_STATE;
  return { kind: "neutral", label: "Idle" };
}
/** 実行や対応が進行中の項目を先にし、その中では更新時刻、次いで ID の降順にする。 */
export function sortAuxiliarySessions(
  sessions: readonly AuxiliarySessionSummary[],
): AuxiliarySessionSummary[] {
  /** 通常の実行だけでなく停止処理と対応待ちも、優先表示する進行中の項目に含める。 */
  const isActive = (session: AuxiliarySessionSummary) =>
    ["running", "approval"].includes(
      getHomeAuxiliarySessionState(session).kind,
    );
  return [...sessions].sort(
    (left, right) =>
      Number(isActive(right)) - Number(isActive(left)) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id),
  );
}
/** 取得済みの一覧ページを維持しつつ、Monitor は現在の監視対象と検索条件の両方で絞り込む。 */
export function buildHomeSessionProjection(
  sessions: readonly HomeSessionSummary[],
  monitorSessionIds: readonly string[],
  sessionSearchText: string,
  auxiliarySessionSummaries: readonly AuxiliarySessionSummary[] = [],
  pageSessionIds?: ReadonlySet<string>,
): HomeSessionProjection {
  const normalizedSessionSearch = sessionSearchText.trim().toLocaleLowerCase();
  const byParent = new Map<string, AuxiliarySessionSummary[]>();
  for (const auxiliary of auxiliarySessionSummaries)
    byParent.set(auxiliary.parentSessionId, [
      ...(byParent.get(auxiliary.parentSessionId) ?? []),
      auxiliary,
    ]);
  for (const [id, auxiliaries] of byParent)
    byParent.set(id, sortAuxiliarySessions(auxiliaries));
  /** タイトル・ワークスペース・Character・種別のどれかに検索語が含まれるかを見る。 */
  const matchesSearch = (session: HomeSessionSummary) => {
    if (!normalizedSessionSearch) return true;
    return [
      session.taskTitle,
      session.workspacePath,
      session.workspaceLabel,
      session.character,
      ...getHomeSessionKindSearchLabels(session),
    ]
      .map((value) => value.toLocaleLowerCase())
      .some((value) => value.includes(normalizedSessionSearch));
  };
  // ページに含める対象はバックエンドで絞り込み済み。次の結果が届くまで保持する。
  const filteredSessionEntries = sessions
    .filter(
      (session) => pageSessionIds?.has(session.id) || matchesSearch(session),
    )
    .map((session) => {
      const auxiliarySessions = [...(byParent.get(session.id) ?? [])];
      return {
        kind: "agent" as const,
        session,
        state: getHomeSessionState(session, auxiliarySessions),
        mainState: getHomeSessionState(session),
        auxiliarySessions,
      };
    });
  const monitorIds = new Set(monitorSessionIds);
  const monitorEntries = filteredSessionEntries.filter(
    ({ session }) => monitorIds.has(session.id) && matchesSearch(session),
  );
  const approvalMonitorEntries = monitorEntries.filter(
    ({ state }) => state.kind === "approval",
  );
  const runningMonitorEntries = monitorEntries.filter(
    ({ state }) => state.kind === "running",
  );
  const nonRunningMonitorEntries = monitorEntries.filter(
    ({ state }) => state.kind !== "running" && state.kind !== "approval",
  );
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
