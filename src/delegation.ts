import type {
  SessionRuntimeCreateInput,
  SessionRuntimeEnqueueInput,
  SessionRuntimeError,
  SessionRuntimeWorkItemCreateInput,
  SessionRuntimeWorkItemAggregationRetryInput,
} from "./session-external-runtime-contract.js";

export const DELEGATION_MAX_ITEMS = 20;
export const DELEGATION_STATES = ["preparing", "prepared", "dispatching", "active", "completed", "cancelling", "cancelled", "compensating", "compensated", "recovery_required"] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];
export type DelegationItemInput = {
  target:
    | { kind: "existing"; sessionId: string }
    | { kind: "create"; session: Omit<SessionRuntimeCreateInput, "idempotencyKey"> };
  work:
    | { kind: "create"; contract: Omit<SessionRuntimeWorkItemCreateInput, "targetSessionId" | "expectedContainerRevision" | "idempotencyKey"> }
    | { kind: "existing"; workItemId: string }
    | { kind: "root" }
    | { kind: "replacement"; request: Omit<SessionRuntimeWorkItemAggregationRetryInput, "targetSessionId" | "idempotencyKey"> };
  turn: Omit<SessionRuntimeEnqueueInput, "sessionId" | "workItemId" | "idempotencyKey" | "expectedContainerRevision">;
};
export type DelegationCreateInput = {
  idempotencyKey: string;
  dispatch: "prepare" | "enqueue";
  items: DelegationItemInput[];
};
export type DelegationGetInput = { delegationId: string };
export type DelegationListInput = { limit: number; cursor?: string };
export type DelegationMutationInput = DelegationGetInput & { expectedRevision: number; idempotencyKey: string };
export type DelegationRetryInput = DelegationMutationInput & { dispatch: "prepare" | "enqueue" };
export type DelegationItem = {
  index: number;
  sessionId: string | null;
  workItemId: string | null;
  executionId: string | null;
  createdSession: boolean;
  createdWorkItem: boolean;
  state: DelegationState;
  pendingStep: string | null;
  effect: "not_applied" | "applied" | "indeterminate";
  error: SessionRuntimeError["error"] | null;
};
export type Delegation = {
  id: string;
  revision: number;
  state: DelegationState;
  items: DelegationItem[];
  recoveryActions: Array<"retry" | "cancel" | "compensate">;
  createdAt: string;
  updatedAt: string;
};
export type DelegationListResult = { items: Delegation[]; nextCursor?: string };
