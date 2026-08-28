export const WORK_ITEM_CONTRACT_REVISION = 1 as const;
export const WORK_ITEM_DEFAULT_LIST_LIMIT = 50;
export const WORK_ITEM_MAX_LIST_LIMIT = 200;
export const WORK_ITEM_MAX_RESULT_BYTES = 256 * 1024;
export const WORK_ITEM_MAX_TEXT_LENGTH = 16_000;
export const WORK_ITEM_MAX_RESULT_ITEMS = 100;
export const WORK_ITEM_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export const WORK_ITEM_STATES = [
  "pending",
  "in_progress",
  "waiting",
  "completed",
  "partially_completed",
  "failed",
  "canceled",
] as const;

export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
export type WorkItemTerminalState = Extract<
  WorkItemState,
  "completed" | "partially_completed" | "failed" | "canceled"
>;
export type WorkItemResultState = Exclude<WorkItemTerminalState, "canceled">;

export const WORK_ITEM_ACTIVE_STATES = ["pending", "in_progress", "waiting"] as const;
export const WORK_ITEM_RESULT_STATES = ["completed", "partially_completed", "failed"] as const;

export type WorkItemSourceIdentity = Readonly<{
  workspace: string | null;
  repository: string | null;
  branch: string | null;
  base: string | null;
  head: string | null;
}>;

export type WorkItemBinding = Readonly<{
  rootSessionId: string;
  creatorSessionId: string;
  targetSessionId: string;
  parentWorkItemId: string | null;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItemSourceIdentity;
}>;

export type WorkItemVerificationResult = Readonly<{
  name: string;
  status: "passed" | "failed" | "not_run";
  details: string;
}>;

export type WorkItemResult<S extends WorkItemResultState = WorkItemResultState> = Readonly<{
  outcome: S;
  summary: string;
  changes: readonly string[];
  verificationResults: readonly WorkItemVerificationResult[];
  findings: readonly string[];
  unverifiedItems: readonly string[];
  remainingWork: readonly string[];
  reportingSessionId: string;
  reportedAt: string;
}>;

type WorkItemBase = WorkItemBinding & Readonly<{
  id: string;
  sequence: number;
  contractRevision: typeof WORK_ITEM_CONTRACT_REVISION;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkItem = WorkItemBase & (
  | Readonly<{ state: (typeof WORK_ITEM_ACTIVE_STATES)[number] | "canceled"; result: null }>
  | {
      [S in WorkItemResultState]: Readonly<{ state: S; result: WorkItemResult<S> }>;
    }[WorkItemResultState]
);

export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
  pending: ["in_progress", "canceled"],
  in_progress: ["waiting", "completed", "partially_completed", "failed", "canceled"],
  waiting: ["in_progress", "completed", "partially_completed", "failed", "canceled"],
  completed: [],
  partially_completed: [],
  failed: [],
  canceled: [],
};

export function isWorkItemActive(state: WorkItemState): boolean {
  return (WORK_ITEM_ACTIVE_STATES as readonly WorkItemState[]).includes(state);
}

export function isWorkItemResultState(state: WorkItemState): state is WorkItemResultState {
  return (WORK_ITEM_RESULT_STATES as readonly WorkItemState[]).includes(state);
}

export function canTransitionWorkItem(from: WorkItemState, to: WorkItemState): boolean {
  return WORK_ITEM_TRANSITIONS[from].includes(to);
}
