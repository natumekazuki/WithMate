import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { HomeCrewMember } from "../../src-shared/window/home-crew-types.js";
import { getHomeSessionState, HOME_SESSION_FAILURE_STATE, sortAuxiliarySessions, type HomeSessionState } from "./home-session-projection.js";

type CountedState = HomeSessionState & { count: number };

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

export type HomeCrewBranch = { node: HomeCrewNode; children: HomeCrewBranch[] };

const stateOrder = ["Attention", "Running", "Canceling", "Waiting For Stop", HOME_SESSION_FAILURE_STATE.label, "Idle", "Saved", "Unknown"];

function compareMembers(left: HomeCrewMember, right: HomeCrewMember): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id, "en");
}

/** Project the complete saved hierarchy. Window presence decides root membership, not branch membership. */
export function buildHomeCrewTree(
  members: readonly HomeCrewMember[],
  auxiliaries: readonly AuxiliarySessionSummary[],
): HomeCrewNode[] {
  const openRoots = new Set(members.filter((member) => member.isWindowOpen).map((member) => member.rootSessionId));
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

  const buildNode = (member: HomeCrewMember): HomeCrewNode => {
    const children = (childrenByParent.get(member.id) ?? [])
      .filter((child) => child.rootSessionId === member.rootSessionId)
      .sort(compareMembers)
      .map(buildNode);
    const counts = new Map<string, CountedState>();
    const add = (state: HomeSessionState, count: number) => {
      const total = (counts.get(state.label)?.count ?? 0) + count;
      counts.set(state.label, { ...state, count: total });
    };
    let openDescendants = 0;
    let hasUnreadDescendant = false;
    for (const child of children) {
      add(child.state, 1);
      for (const state of child.descendantStates) add(state, state.count);
      openDescendants += Number(child.member.isWindowOpen) + child.openDescendants;
      hasUnreadDescendant ||= child.member.hasUnreadResult === true || child.hasUnreadDescendant;
    }
    return {
      key: JSON.stringify([member.id, member.incarnationId]),
      member,
      state: getHomeSessionState(member),
      auxiliaries: sortAuxiliarySessions(auxiliariesByParent.get(member.id) ?? []),
      children,
      descendantStates: [...counts.values()].sort((left, right) => stateOrder.indexOf(left.label) - stateOrder.indexOf(right.label)),
      openDescendants,
      hasUnreadDescendant,
    };
  };
  return roots.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id, "en")).map(buildNode);
}

/** Keep matching paths and all descendants of a match without changing the complete-tree totals. */
export function filterHomeCrewTree(roots: readonly HomeCrewNode[], query: string): HomeCrewBranch[] {
  const visit = (nodes: readonly HomeCrewNode[], includeAll: boolean): HomeCrewBranch[] => nodes.flatMap((node) => {
    const matches = includeAll || [node.member.taskTitle, node.member.character]
      .some((value) => value.toLocaleLowerCase().includes(query));
    const children = visit(node.children, matches);
    return matches || children.length > 0 ? [{ node, children }] : [];
  });
  return visit(roots, !query);
}

export function getHomeCrewDisplayCounts(states: readonly CountedState[]) {
  const running = states.filter((state) => state.kind === "running");
  const runningCount = running.reduce((total, state) => total + state.count, 0);
  return states.flatMap((state) => {
    if (state.kind !== "running") return [{ ...state, description: `${state.label}: ${state.count}` }];
    return state === running[0] ? [{
      ...state,
      count: runningCount,
      description: running.map((item) => `${item.label}: ${item.count}`).join(", "),
    }] : [];
  });
}
