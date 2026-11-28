import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { HomeCrewMember } from "../../src-shared/window/home-crew-types.js";
import {
  getHomeSessionState,
  HOME_SESSION_FAILURE_STATE,
  sortAuxiliarySessions,
  type HomeSessionState,
} from "./home-session-projection.js";

/** 表示状態ごとに同じ状態の子孫 Main を集計した項目。 */
type CountedState = HomeSessionState & { count: number };

/** 一つの Main の状態と直下の Auxiliary・子 Main、および表示対象の枝全体の子孫集計。 */
export type HomeCrewNode = {
  key: string;
  member: HomeCrewMember;
  state: HomeSessionState;
  auxiliaries: AuxiliarySessionSummary[];
  children: HomeCrewNode[];
  descendantStates: CountedState[];
  openDescendants: number;
  hasUnreadDescendant: boolean;
};

/** 検索結果に残す表示上の枝。正本のノードは子孫の完全な集計を維持する。 */
export type HomeCrewBranch = { node: HomeCrewNode; children: HomeCrewBranch[] };

const stateOrder = [
  "Attention",
  "Running",
  "Canceling",
  "Waiting For Stop",
  HOME_SESSION_FAILURE_STATE.label,
  "Idle",
  "Saved",
  "Unknown",
];

/** 兄弟を作成時刻の昇順にし、同時刻なら ID で順序を固定する。 */
function compareMembers(left: HomeCrewMember, right: HomeCrewMember): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id, "en")
  );
}

/** 保存済みの階層全体を表示用に構成する。Window の有無はルートに含めるかを決めるもので、枝の所属は変えない。 */
export function buildHomeCrewTree(
  members: readonly HomeCrewMember[],
  auxiliaries: readonly AuxiliarySessionSummary[],
): HomeCrewNode[] {
  const openRoots = new Set(
    members
      .filter((member) => member.isWindowOpen)
      .map((member) => member.rootSessionId),
  );
  const roots: HomeCrewMember[] = [];
  const childrenByParent = new Map<string, HomeCrewMember[]>();
  const auxiliariesByParent = new Map<string, AuxiliarySessionSummary[]>();
  for (const member of members) {
    if (!openRoots.has(member.rootSessionId)) continue;
    if (member.parentSessionId === null) {
      if (member.id === member.rootSessionId) roots.push(member);
    } else {
      const siblings = childrenByParent.get(member.parentSessionId);
      if (siblings) siblings.push(member);
      else childrenByParent.set(member.parentSessionId, [member]);
    }
  }
  for (const auxiliary of auxiliaries) {
    const siblings = auxiliariesByParent.get(auxiliary.parentSessionId);
    if (siblings) siblings.push(auxiliary);
    else auxiliariesByParent.set(auxiliary.parentSessionId, [auxiliary]);
  }

  /** 同じ Crew の子だけを再帰的に組み立て、表示状態と開いている子孫、未読の有無を集計する。 */
  const buildNode = (member: HomeCrewMember): HomeCrewNode => {
    const children = (childrenByParent.get(member.id) ?? [])
      .filter((child) => child.rootSessionId === member.rootSessionId)
      .sort(compareMembers)
      .map(buildNode);
    const counts = new Map<string, CountedState>();
    /** 同じ表示名の集計へ子自身または子の集計値を足す。 */
    const add = (state: HomeSessionState, count: number) => {
      const total = (counts.get(state.label)?.count ?? 0) + count;
      counts.set(state.label, { ...state, count: total });
    };
    let openDescendants = 0;
    let hasUnreadDescendant = false;
    for (const child of children) {
      add(child.state, 1);
      for (const state of child.descendantStates) add(state, state.count);
      openDescendants +=
        Number(child.member.isWindowOpen) + child.openDescendants;
      hasUnreadDescendant ||=
        child.member.hasUnreadResult === true || child.hasUnreadDescendant;
    }
    return {
      key: JSON.stringify([member.id, member.incarnationId]),
      member,
      state: getHomeSessionState(member),
      auxiliaries: sortAuxiliarySessions(
        auxiliariesByParent.get(member.id) ?? [],
      ),
      children,
      descendantStates: [...counts.values()].sort(
        (left, right) =>
          stateOrder.indexOf(left.label) - stateOrder.indexOf(right.label),
      ),
      openDescendants,
      hasUnreadDescendant,
    };
  };
  return roots
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id, "en"),
    )
    .map(buildNode);
}

/** 一致したノードまでの経路とそのノードの子孫すべてを残し、ツリー全体の集計値は変えない。 */
export function filterHomeCrewTree(
  roots: readonly HomeCrewNode[],
  query: string,
): HomeCrewBranch[] {
  /** 名称が一致すれば以降の枝は無条件に残し、一致しなくても子に結果があればその経路を残す。 */
  const visit = (
    nodes: readonly HomeCrewNode[],
    includeAll: boolean,
  ): HomeCrewBranch[] =>
    nodes.flatMap((node) => {
      const matches =
        includeAll ||
        [node.member.taskTitle, node.member.character].some((value) =>
          value.toLocaleLowerCase().includes(query),
        );
      const children = visit(node.children, matches);
      return matches || children.length > 0 ? [{ node, children }] : [];
    });
  return visit(roots, !query);
}

/** 実行中に属する複数の状態を一つの表示件数にまとめつつ、内訳は説明に残す。 */
export function getHomeCrewDisplayCounts(states: readonly CountedState[]) {
  const running = states.filter((state) => state.kind === "running");
  const runningCount = running.reduce((total, state) => total + state.count, 0);
  return states.flatMap((state) => {
    if (state.kind !== "running")
      return [{ ...state, description: `${state.label}: ${state.count}` }];
    return state === running[0]
      ? [
          {
            ...state,
            count: runningCount,
            description: running
              .map((item) => `${item.label}: ${item.count}`)
              .join(", "),
          },
        ]
      : [];
  });
}
