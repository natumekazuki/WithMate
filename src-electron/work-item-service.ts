import { createHash } from "node:crypto";

import { requireSessionRoleBinding } from "../src/session-role-binding.js";
import {
  canSendSessionTurn,
  type SessionTurnAuthoritySession,
} from "../src/session-turn-communication-authority.js";
import {
  WORK_ITEM_IDEMPOTENCY_RETENTION_MS,
  isWorkItemActive,
  type WorkItem,
  type WorkItemAggregationDecision,
  type WorkItemAggregationDecisionType,
  type WorkItemAggregationListItem,
  type WorkItemAggregationSummary,
  type WorkItemBinding,
  type WorkItemResult,
  type WorkItemResultState,
  type WorkItemSourceIdentity,
  type WorkItemState,
} from "../src/work-item.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import {
  WorkItemNotFoundError,
  type WorkItemStorageV6,
} from "./work-item-storage-v6.js";

export type WorkItemCreateInput = {
  targetSessionId: string;
  parentWorkItemId?: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItemSourceIdentity;
  idempotencyKey: string;
};

export type WorkItemTransitionInput = {
  workItemId: string;
  state: "in_progress" | "waiting";
  expectedRevision: number;
  idempotencyKey: string;
};

export type WorkItemResultInput = {
  workItemId: string;
  state: WorkItemResultState;
  expectedRevision: number;
  result: Omit<WorkItemResult, "outcome" | "reportingSessionId" | "reportedAt">;
  idempotencyKey: string;
  expectedAggregateRevision?: number;
};

export type WorkItemAggregationGetInput = {
  parentWorkItemId: string;
};

export type WorkItemAggregationListInput = {
  parentWorkItemId: string;
  decision?: WorkItemAggregationDecisionType;
  limit: number;
  afterSequence: number | null;
};

export type WorkItemAggregationDecisionInput = {
  parentWorkItemId: string;
  childWorkItemId: string;
  decision: "accepted" | "excluded";
  reason?: string;
  expectedAggregateRevision: number;
  idempotencyKey: string;
};

export type WorkItemAggregationRetryInput = {
  parentWorkItemId: string;
  childWorkItemId: string;
  targetSessionId: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItemSourceIdentity;
  reason?: string;
  expectedAggregateRevision: number;
  idempotencyKey: string;
};

export type WorkItemCancelInput = {
  workItemId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type WorkItemListInput = {
  creatorSessionId?: string;
  targetSessionId?: string;
  state?: WorkItemState;
  limit: number;
  afterSequence: number | null;
};

export type WorkItemListScope = Readonly<{
  rootSessionId: string;
  actorSessionId: string;
  visibility: "root" | "actor";
}>;

export class WorkItemAuthorityError extends Error {
  readonly code = "WORK_ITEM_FORBIDDEN";
  constructor(message: string, readonly details: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = "WorkItemAuthorityError";
  }
}

export class WorkItemParentError extends Error {
  readonly code = "WORK_ITEM_PARENT_INVALID";
  constructor(readonly parentWorkItemId: string) {
    super("The parent Work Item is not an active assignment of the actor Session in the same root.");
    this.name = "WorkItemParentError";
  }
}

export class WorkItemExecutionAssociationError extends Error {
  readonly code = "WORK_ITEM_EXECUTION_FORBIDDEN";
  constructor(message: string, readonly workItemId: string) {
    super(message);
    this.name = "WorkItemExecutionAssociationError";
  }
}

export class WorkItemService {
  constructor(private readonly deps: {
    storage: Pick<
      WorkItemStorageV6,
      "cleanupExpiredIdempotency" | "create" | "get" | "iteratePage" | "listPage" | "mutate" | "resolveIdempotency"
      | "getAggregationSummary" | "listAggregationItems" | "decideAggregation" | "retryAggregation"
      | "resolveAggregationIdempotency"
    >;
    getTurnAuthoritySession(sessionId: string): SessionTurnAuthoritySession | null;
    createWorkItemId(): string;
    currentTimestamp(): string;
  }) {}

  create(input: WorkItemCreateInput, binding: ResolvedAgentRuntimeBinding): WorkItem {
    const createdAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.create",
      binding.actorSessionId,
      input.idempotencyKey,
      fingerprint,
      createdAt,
    );
    if (replay) return replay;

    const actor = this.requireSession(binding.actorSessionId);
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    if (actorBinding.sessionRole !== "overall-coordinator" && actorBinding.sessionRole !== "task-coordinator") {
      throw new WorkItemAuthorityError("Only coordinator Sessions can create Work Items.", {
        actorSessionId: actor.sessionId,
      });
    }
    if (actor.sessionId === input.targetSessionId) {
      throw new WorkItemAuthorityError("A Work Item target must differ from its creator.", {
        actorSessionId: actor.sessionId,
        targetSessionId: input.targetSessionId,
      });
    }
    const target = this.requireSession(input.targetSessionId);
    const targetBinding = requireSessionRoleBinding(target.sessionId, target);
    if (
      targetBinding.parentSessionId !== actor.sessionId
      || !canSendSessionTurn(
        { sessionId: actor.sessionId, ...actorBinding },
        { sessionId: target.sessionId, ...targetBinding },
      )
    ) {
      throw new WorkItemAuthorityError("The actor Session cannot delegate to the target Session.", {
        actorSessionId: actor.sessionId,
        targetSessionId: target.sessionId,
      });
    }
    if (input.parentWorkItemId) {
      const parent = this.deps.storage.get(input.parentWorkItemId);
      if (
        !parent
        || parent.rootSessionId !== actorBinding.rootSessionId
        || parent.targetSessionId !== actor.sessionId
        || !isWorkItemActive(parent.state)
      ) {
        throw new WorkItemParentError(input.parentWorkItemId);
      }
    }
    const bindingRecord: WorkItemBinding = {
      rootSessionId: actorBinding.rootSessionId,
      creatorSessionId: actor.sessionId,
      targetSessionId: target.sessionId,
      parentWorkItemId: input.parentWorkItemId ?? null,
      goal: input.goal,
      scope: input.scope,
      completionCriteria: input.completionCriteria,
      authority: input.authority,
      sourceIdentity: { ...input.sourceIdentity },
    };
    return this.deps.storage.create({
      id: this.deps.createWorkItemId(),
      binding: bindingRecord,
      principalSessionId: actor.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      createdAt,
      expiresAt: resolveIdempotencyExpiresAt(createdAt),
    });
  }

  transition(input: WorkItemTransitionInput, binding: ResolvedAgentRuntimeBinding): WorkItem {
    return this.targetMutation("work.transition", input, binding, input.state, null);
  }

  reportResult(input: WorkItemResultInput, binding: ResolvedAgentRuntimeBinding): WorkItem {
    const reportedAt = this.deps.currentTimestamp();
    const result: WorkItemResult = {
      outcome: input.state,
      summary: input.result.summary,
      changes: [...input.result.changes],
      verificationResults: input.result.verificationResults.map((item) => ({ ...item })),
      findings: [...input.result.findings],
      unverifiedItems: [...input.result.unverifiedItems],
      remainingWork: [...input.result.remainingWork],
      reportingSessionId: binding.actorSessionId,
      reportedAt,
    };
    return this.targetMutation("work.result", input, binding, input.state, result, reportedAt);
  }

  cancel(input: WorkItemCancelInput, binding: ResolvedAgentRuntimeBinding): WorkItem {
    const updatedAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.cancel",
      binding.actorSessionId,
      input.idempotencyKey,
      fingerprint,
      updatedAt,
    );
    if (replay) return replay;
    const item = this.requireVisibleItem(input.workItemId, binding, false);
    if (item.creatorSessionId !== binding.actorSessionId || !isWorkItemActive(item.state)) {
      throw new WorkItemAuthorityError("Only the creator can cancel its active Work Item.", {
        workItemId: item.id,
        actorSessionId: binding.actorSessionId,
      });
    }
    return this.deps.storage.mutate({
      operation: "work.cancel",
      workItemId: item.id,
      principalSessionId: binding.actorSessionId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      expectedRevision: input.expectedRevision,
      state: "canceled",
      result: null,
      updatedAt,
      expiresAt: resolveIdempotencyExpiresAt(updatedAt),
    });
  }

  get(workItemId: string, binding: ResolvedAgentRuntimeBinding): WorkItem {
    return this.requireVisibleItem(workItemId, binding, true);
  }

  list(input: WorkItemListInput, binding: ResolvedAgentRuntimeBinding): WorkItem[] {
    return Array.from(this.iterateList(input, this.resolveListScope(binding)));
  }

  resolveListScope(binding: ResolvedAgentRuntimeBinding): WorkItemListScope {
    const actor = this.requireSession(binding.actorSessionId);
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    return {
      rootSessionId: actorBinding.rootSessionId,
      actorSessionId: actor.sessionId,
      visibility: actorBinding.sessionRole === "overall-coordinator" ? "root" : "actor",
    };
  }

  iterateList(input: WorkItemListInput, scope: WorkItemListScope): Iterable<WorkItem> {
    return this.deps.storage.iteratePage({
      rootSessionId: scope.rootSessionId,
      visibleSessionId: scope.actorSessionId,
      canSeeRoot: scope.visibility === "root",
      ...(input.creatorSessionId === undefined ? {} : { creatorSessionId: input.creatorSessionId }),
      ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
      ...(input.state === undefined ? {} : { state: input.state }),
      afterSequence: input.afterSequence,
      limit: input.limit,
    });
  }

  requireExecutionAssociation(
    workItemId: string,
    actorSessionId: string,
    targetSessionId: string,
  ): WorkItem {
    const item = this.deps.storage.get(workItemId);
    if (!item) throw new WorkItemNotFoundError(workItemId);
    const actor = this.requireSession(actorSessionId);
    const target = this.requireSession(targetSessionId);
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    const targetBinding = requireSessionRoleBinding(target.sessionId, target);
    if (
      item.rootSessionId !== actorBinding.rootSessionId
      || item.rootSessionId !== targetBinding.rootSessionId
      || item.targetSessionId !== target.sessionId
      || (item.creatorSessionId !== actor.sessionId && item.targetSessionId !== actor.sessionId)
      || !isWorkItemActive(item.state)
      || !canSendSessionTurn(
        { sessionId: actor.sessionId, ...actorBinding },
        { sessionId: target.sessionId, ...targetBinding },
      )
    ) {
      throw new WorkItemExecutionAssociationError(
        "The Work Item cannot be associated with this execution.",
        workItemId,
      );
    }
    return item;
  }

  cleanupExpiredIdempotency(): number {
    return this.deps.storage.cleanupExpiredIdempotency(this.deps.currentTimestamp());
  }

  getAggregation(input: WorkItemAggregationGetInput, binding: ResolvedAgentRuntimeBinding): WorkItemAggregationSummary {
    this.requireVisibleItem(input.parentWorkItemId, binding, true);
    return this.deps.storage.getAggregationSummary(input.parentWorkItemId);
  }

  listAggregation(input: WorkItemAggregationListInput, binding: ResolvedAgentRuntimeBinding): WorkItemAggregationListItem[] {
    this.requireVisibleItem(input.parentWorkItemId, binding, true);
    return this.deps.storage.listAggregationItems(input);
  }

  decideAggregation(input: WorkItemAggregationDecisionInput, binding: ResolvedAgentRuntimeBinding): WorkItemAggregationDecision {
    const decidedAt = this.deps.currentTimestamp();
    const requestFingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveAggregationIdempotency(
      "work.aggregation.decide",
      binding.actorSessionId,
      input.idempotencyKey,
      requestFingerprint,
      decidedAt,
    );
    if (replay) return replay;
    this.requireAggregationActor(input.parentWorkItemId, binding);
    return this.deps.storage.decideAggregation({
      ...input,
      actorSessionId: binding.actorSessionId,
      reason: input.reason ?? null,
      requestFingerprint,
      decidedAt,
      expiresAt: resolveIdempotencyExpiresAt(decidedAt),
    });
  }

  retryAggregation(input: WorkItemAggregationRetryInput, binding: ResolvedAgentRuntimeBinding): { decision: WorkItemAggregationDecision; replacement: WorkItem } {
    const decidedAt = this.deps.currentTimestamp();
    const requestFingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveAggregationIdempotency(
      "work.aggregation.retry",
      binding.actorSessionId,
      input.idempotencyKey,
      requestFingerprint,
      decidedAt,
    );
    if (replay) {
      const replacement = replay.replacementWorkItemId === null
        ? null
        : this.deps.storage.get(replay.replacementWorkItemId);
      if (!replacement) throw new Error("A retry idempotency result is missing its replacement Work Item.");
      return { decision: replay, replacement };
    }
    const parent = this.requireAggregationActor(input.parentWorkItemId, binding);
    const actor = this.requireSession(binding.actorSessionId);
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    const target = this.requireSession(input.targetSessionId);
    const targetBinding = requireSessionRoleBinding(target.sessionId, target);
    if (targetBinding.parentSessionId !== actor.sessionId || !canSendSessionTurn(
      { sessionId: actor.sessionId, ...actorBinding },
      { sessionId: target.sessionId, ...targetBinding },
    )) {
      throw new WorkItemAuthorityError("The actor Session cannot delegate the replacement to the target Session.", {
        actorSessionId: actor.sessionId,
        targetSessionId: target.sessionId,
      });
    }
    return this.deps.storage.retryAggregation({
      parentWorkItemId: input.parentWorkItemId,
      childWorkItemId: input.childWorkItemId,
      actorSessionId: binding.actorSessionId,
      expectedAggregateRevision: input.expectedAggregateRevision,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      replacementId: this.deps.createWorkItemId(),
      replacementBinding: {
        rootSessionId: parent.rootSessionId,
        creatorSessionId: binding.actorSessionId,
        targetSessionId: input.targetSessionId,
        parentWorkItemId: parent.id,
        goal: input.goal,
        scope: input.scope,
        completionCriteria: input.completionCriteria,
        authority: input.authority,
        sourceIdentity: { ...input.sourceIdentity },
      },
      reason: input.reason ?? null,
      decidedAt,
      expiresAt: resolveIdempotencyExpiresAt(decidedAt),
    });
  }

  private targetMutation(
    operation: "work.transition" | "work.result",
    input: WorkItemTransitionInput | WorkItemResultInput,
    binding: ResolvedAgentRuntimeBinding,
    state: WorkItemState,
    result: WorkItemResult | null,
    updatedAt = this.deps.currentTimestamp(),
  ): WorkItem {
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      operation,
      binding.actorSessionId,
      input.idempotencyKey,
      fingerprint,
      updatedAt,
    );
    if (replay) return replay;
    const item = this.requireVisibleItem(input.workItemId, binding, false);
    if (item.targetSessionId !== binding.actorSessionId) {
      throw new WorkItemAuthorityError("Only the target Session can mutate assignment progress or report a result.", {
        workItemId: item.id,
        actorSessionId: binding.actorSessionId,
      });
    }
    return this.deps.storage.mutate({
      operation,
      workItemId: item.id,
      principalSessionId: binding.actorSessionId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      expectedRevision: input.expectedRevision,
      state,
      result,
      updatedAt,
      expiresAt: resolveIdempotencyExpiresAt(updatedAt),
      ...(operation === "work.result" && "expectedAggregateRevision" in input && input.expectedAggregateRevision !== undefined
        ? { expectedAggregateRevision: input.expectedAggregateRevision }
        : {}),
    });
  }

  private requireAggregationActor(parentWorkItemId: string, binding: ResolvedAgentRuntimeBinding): WorkItem {
    const parent = this.requireVisibleItem(parentWorkItemId, binding, false);
    if (parent.targetSessionId !== binding.actorSessionId) {
      throw new WorkItemAuthorityError("Only the parent target Session can mutate its aggregation.", {
        parentWorkItemId,
        actorSessionId: binding.actorSessionId,
      });
    }
    const actor = this.requireSession(binding.actorSessionId);
    const role = requireSessionRoleBinding(actor.sessionId, actor).sessionRole;
    if (role !== "overall-coordinator" && role !== "task-coordinator") {
      throw new WorkItemAuthorityError("Only coordinator Sessions can mutate Work Item aggregation.");
    }
    return parent;
  }

  private requireVisibleItem(
    workItemId: string,
    binding: ResolvedAgentRuntimeBinding,
    allowRootCoordinator: boolean,
  ): WorkItem {
    const item = this.deps.storage.get(workItemId);
    if (!item) throw new WorkItemNotFoundError(workItemId);
    const actor = this.requireSession(binding.actorSessionId);
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    const visible = item.rootSessionId === actorBinding.rootSessionId && (
      item.creatorSessionId === actor.sessionId
      || item.targetSessionId === actor.sessionId
      || (allowRootCoordinator && actorBinding.sessionRole === "overall-coordinator")
    );
    if (!visible) {
      throw new WorkItemAuthorityError("The actor Session cannot access this Work Item.", {
        workItemId,
        actorSessionId: actor.sessionId,
      });
    }
    return item;
  }

  private requireSession(sessionId: string): SessionTurnAuthoritySession {
    const session = this.deps.getTurnAuthoritySession(sessionId);
    if (!session) throw new WorkItemAuthorityError("The required Session was not found.", { sessionId });
    return session;
  }
}

function resolveIdempotencyExpiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + WORK_ITEM_IDEMPOTENCY_RETENTION_MS).toISOString();
}

function fingerprintMutation(input: unknown, actorSessionId: string): string {
  return createHash("sha256").update(stableJson({ actorSessionId, input })).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
