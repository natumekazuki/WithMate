export const WORK_ITEM_CONTRACT_REVISION = 2 as const;
export const WORK_ITEM_DEFAULT_LIST_LIMIT = 50;
export const WORK_ITEM_MAX_LIST_LIMIT = 200;
export const WORK_ITEM_MAX_RESULT_BYTES = 256 * 1024;
export const WORK_ITEM_MAX_TEXT_LENGTH = 16_000;
export const WORK_ITEM_MAX_RESULT_ITEMS = 100;
export const WORK_ITEM_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const WORK_ITEM_AGGREGATION_CONTRACT_REVISION = 1 as const;
export const WORK_ITEM_AGGREGATION_DEFAULT_LIST_LIMIT = 50;
export const WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT = 200;
export const WORK_ITEM_AGGREGATION_DECISIONS = ["accepted", "excluded", "retry_requested"] as const;
export const WORK_ITEM_KINDS = ["root", "delegated"] as const;
export const WORK_ITEM_EVENT_TYPES = [
  "created",
  "migration_baseline",
  "contract_revised",
  "progress",
  "handoff",
  "state_transitioned",
  "result_reported",
] as const;

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
export type WorkItemAggregationDecisionType = (typeof WORK_ITEM_AGGREGATION_DECISIONS)[number];
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export type WorkItemEventType = (typeof WORK_ITEM_EVENT_TYPES)[number];

export const WORK_ITEM_ACTIVE_STATES = ["pending", "in_progress", "waiting"] as const;
export const WORK_ITEM_RESULT_STATES = ["completed", "partially_completed", "failed"] as const;

export type WorkItemSourceIdentity = Readonly<{
  workspace: string | null;
  repository: string | null;
  branch: string | null;
  base: string | null;
  head: string | null;
}>;

type WorkItemBindingBase = Readonly<{
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

export type RootWorkItemBinding = WorkItemBindingBase & Readonly<{
  kind: "root";
}>;

export type DelegatedWorkItemBinding = WorkItemBindingBase & Readonly<{
  kind: "delegated";
}>;

export type WorkItemBinding = RootWorkItemBinding | DelegatedWorkItemBinding;

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

type WorkItemBase = Readonly<{
  id: string;
  sequence: number;
  contractRevision: typeof WORK_ITEM_CONTRACT_REVISION;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

type WorkItemLifecycle =
  | Readonly<{ state: (typeof WORK_ITEM_ACTIVE_STATES)[number] | "canceled"; result: null }>
  | {
      [S in WorkItemResultState]: Readonly<{ state: S; result: WorkItemResult<S> }>;
    }[WorkItemResultState];

export type RootWorkItem = WorkItemBase & RootWorkItemBinding & WorkItemLifecycle & Readonly<{
  progressSummary: string;
  blockers: readonly string[];
  nextAction: string;
}>;

export type DelegatedWorkItem = WorkItemBase & DelegatedWorkItemBinding & WorkItemLifecycle;

export type WorkItem = RootWorkItem | DelegatedWorkItem;

export type WorkItemContractProjection = Readonly<{
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
}>;

export type WorkItemProgressProjection = Readonly<{
  progressSummary: string;
  blockers: readonly string[];
  nextAction: string;
}>;

export type WorkItemCreatedEventPayload = Readonly<{
  kind: WorkItemKind;
  rootSessionId: string;
  creatorSessionId: string;
  targetSessionId: string;
  parentWorkItemId: string | null;
  sourceIdentity: WorkItemSourceIdentity;
  contract: WorkItemContractProjection;
  progress: WorkItemProgressProjection;
  state: WorkItemState;
  result: WorkItemResult | null;
}>;

export type WorkItemContractRevisedEventPayload = Readonly<{
  before: WorkItemContractProjection;
  after: WorkItemContractProjection;
}>;

export type WorkItemProgressEventPayload = WorkItemProgressProjection;

export type WorkItemStateTransitionedEventPayload = Readonly<{
  from: WorkItemState;
  to: WorkItemState;
}>;

export type WorkItemResultReportedEventPayload = Readonly<{
  from: WorkItemState;
  to: WorkItemResultState;
  result: WorkItemResult;
}>;

type WorkItemEventBase<T extends WorkItemEventType, P> = Readonly<{
  sequence: number;
  workItemId: string;
  revision: number;
  type: T;
  actorSessionId: string | null;
  payload: P;
  createdAt: string;
}>;

export type WorkItemEvent =
  | WorkItemEventBase<"created", WorkItemCreatedEventPayload>
  | WorkItemEventBase<"migration_baseline", WorkItemCreatedEventPayload>
  | WorkItemEventBase<"contract_revised", WorkItemContractRevisedEventPayload>
  | WorkItemEventBase<"progress", WorkItemProgressEventPayload>
  | WorkItemEventBase<"handoff", WorkItemProgressEventPayload>
  | WorkItemEventBase<"state_transitioned", WorkItemStateTransitionedEventPayload>
  | WorkItemEventBase<"result_reported", WorkItemResultReportedEventPayload>;

export type WorkItemAggregationDecision = Readonly<{
  parentWorkItemId: string;
  childWorkItemId: string;
  revision: number;
  childRevision: number;
  actorSessionId: string;
  decision: WorkItemAggregationDecisionType;
  reason: string | null;
  replacementWorkItemId: string | null;
  decidedAt: string;
}>;

export type WorkItemAggregationListItem = Readonly<{
  child: Pick<WorkItem, "id" | "sequence" | "creatorSessionId" | "targetSessionId" | "parentWorkItemId" | "state" | "revision" | "createdAt" | "updatedAt">;
  hasResult: boolean;
  resultSummary: string | null;
  decision: WorkItemAggregationDecision | null;
}>;

export type WorkItemAggregationSummary = Readonly<{
  contractRevision: typeof WORK_ITEM_AGGREGATION_CONTRACT_REVISION;
  parentWorkItemId: string;
  aggregateRevision: number;
  directChildCount: number;
  activeCount: number;
  undecidedTerminalCount: number;
  acceptedCount: number;
  excludedCount: number;
  retryRequestedCount: number;
}>;

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

export function isRootWorkItem(item: WorkItem): item is RootWorkItem {
  return item.kind === "root";
}

export function assertValidWorkItemBinding(binding: WorkItemBinding): void {
  if (binding.kind === "root") {
    if (
      binding.rootSessionId !== binding.creatorSessionId
      || binding.rootSessionId !== binding.targetSessionId
      || binding.parentWorkItemId !== null
    ) {
      throw new TypeError("A root Work Item must be self-owned by its root Session and cannot have a parent.");
    }
    return;
  }
  if (binding.creatorSessionId === binding.targetSessionId) {
    throw new TypeError("A delegated Work Item creator and target must differ.");
  }
  if (
    binding.goal.trim().length === 0
    || binding.scope.trim().length === 0
    || binding.completionCriteria.trim().length === 0
    || binding.authority.trim().length === 0
  ) {
    throw new TypeError("A delegated Work Item contract cannot contain empty text fields.");
  }
}
