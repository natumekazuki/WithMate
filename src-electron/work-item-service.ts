import { createHash } from "node:crypto";

import { requireSessionRoleBinding } from "../src/session-role-binding.js";
import { isAgentMutationProof, type MutationAdmissionProof, type MutationAuthorityProof } from "../src/session-authority.js";
import type { SessionTurnAuthoritySession } from "../src/session-turn-communication-authority.js";
import {
  WORK_ITEM_IDEMPOTENCY_RETENTION_MS,
  WORK_ITEM_MAX_LIST_LIMIT,
  isWorkItemActive,
  isRootWorkItem,
  type RootWorkItem,
  type WorkItem,
  type WorkItemAggregationDecision,
  type WorkItemAggregationDecisionType,
  type WorkItemAggregationListItem,
  type WorkItemAggregationSummary,
  type DelegatedWorkItemBinding,
  type WorkItemEvent,
  type WorkItemResult,
  type WorkItemResultState,
  type WorkItemSourceIdentity,
  type WorkItemState,
} from "../src/work-item.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import {
  WorkItemAggregationConflictError,
  WorkItemNotFoundError,
  type WorkItemStorageV6,
} from "./work-item-storage-v6.js";

export type WorkItemCreateInput = {
  expectedContainerRevision: number;
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

export type WorkItemReviseInput = {
  workItemId: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  expectedRevision: number;
  idempotencyKey: string;
};

type WorkItemHistoryAppendBase = {
  workItemId: string;
  summary: string;
  blockers: readonly string[];
  nextAction: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type WorkItemHistoryAppendInput = WorkItemHistoryAppendBase & (
  | { type: "progress" }
  | { type: "handoff" }
);

export type WorkItemHistoryListInput = {
  workItemId: string;
  limit: number;
  afterSequence: number | null;
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

export type RootWorkItemRestoreInput = {
  predecessorWorkItemId: string;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  sourceIdentity: WorkItemSourceIdentity;
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
  visibility: "root" | "actor" | "creator" | "target";
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
      | "reviseRoot" | "appendRootHistory" | "listHistory" | "listRecentHistory" | "iterateHistory" | "iterateRecentHistory"
      | "createRootSuccessor"
      | "getAggregationSummary" | "listAggregationItems" | "decideAggregation" | "retryAggregation"
      | "resolveAggregationIdempotency"
    >;
    getTurnAuthoritySession(sessionId: string): SessionTurnAuthoritySession | null;
    createWorkItemId(): string;
    currentTimestamp(): string;
  }) {}

  create(input: WorkItemCreateInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
    const createdAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.create",
      proof,
      input.idempotencyKey,
      fingerprint,
      createdAt,
    );
    if (replay) return replay;

    const actor = this.requireSession(binding.actorSessionId);
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    if (actor.sessionId === input.targetSessionId) {
      throw new WorkItemAuthorityError("A Work Item target must differ from its creator.", {
        actorSessionId: actor.sessionId,
        targetSessionId: input.targetSessionId,
      });
    }
    const target = this.requireSession(input.targetSessionId);
    const targetBinding = requireSessionRoleBinding(target.sessionId, target);
    if (targetBinding.parentSessionId !== actor.sessionId || targetBinding.rootSessionId !== actorBinding.rootSessionId) {
      throw new WorkItemAuthorityError("The actor Session cannot delegate to the target Session.", {
        actorSessionId: actor.sessionId,
        targetSessionId: target.sessionId,
      });
    }
    if (input.parentWorkItemId) {
      const parent = this.deps.storage.get(input.parentWorkItemId);
      if (
        !parent
        || parent.kind !== "delegated"
        || parent.rootSessionId !== actorBinding.rootSessionId
        || parent.targetSessionId !== actor.sessionId
        || !isWorkItemActive(parent.state)
      ) {
        throw new WorkItemParentError(input.parentWorkItemId);
      }
    }
    const bindingRecord: DelegatedWorkItemBinding = {
      kind: "delegated",
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
      expectedContainerRevision: input.expectedContainerRevision,
      createdAt,
      expiresAt: resolveIdempotencyExpiresAt(createdAt),
      proof,
    });
  }

  transition(input: WorkItemTransitionInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
    return this.targetMutation("work.transition", input, binding, proof, input.state, null);
  }

  revise(input: WorkItemReviseInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
    const updatedAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.revise",
      proof,
      input.idempotencyKey,
      fingerprint,
      updatedAt,
    );
    if (replay) return replay;
    this.requireRootOwner(input.workItemId, binding);
    return this.deps.storage.reviseRoot({
      ...input,
      principalSessionId: binding.actorSessionId,
      requestFingerprint: fingerprint,
      updatedAt,
      expiresAt: resolveIdempotencyExpiresAt(updatedAt),
      proof,
    });
  }

  appendHistory(input: WorkItemHistoryAppendInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
    const createdAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.history.append",
      proof,
      input.idempotencyKey,
      fingerprint,
      createdAt,
    );
    if (replay) return replay;
    this.requireRootOwner(input.workItemId, binding);
    return this.deps.storage.appendRootHistory({
      workItemId: input.workItemId,
      principalSessionId: binding.actorSessionId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      expectedRevision: input.expectedRevision,
      eventType: input.type,
      summary: input.summary,
      blockers: [...input.blockers],
      nextAction: input.nextAction,
      createdAt,
      expiresAt: resolveIdempotencyExpiresAt(createdAt),
      proof,
    });
  }

  listHistory(input: WorkItemHistoryListInput, binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): WorkItemEvent[] {
    this.requireRootOwner(input.workItemId, binding, proof, "work.history.list");
    return this.deps.storage.listHistory(input);
  }

  iterateHistory(input: WorkItemHistoryListInput, binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): Iterable<WorkItemEvent> {
    this.requireRootOwner(input.workItemId, binding, proof, "work.history.list");
    return this.deps.storage.iterateHistory(input);
  }

  listRecentHistory(
    input: Pick<WorkItemHistoryListInput, "workItemId" | "limit">,
    binding: ResolvedAgentRuntimeBinding,
    proof?: MutationAuthorityProof,
  ): WorkItemEvent[] {
    this.requireRootOwner(input.workItemId, binding, proof, "work.history.list");
    return this.deps.storage.listRecentHistory(input);
  }

  iterateRecentHistory(
    input: Pick<WorkItemHistoryListInput, "workItemId" | "limit">,
    binding: ResolvedAgentRuntimeBinding,
    proof?: MutationAuthorityProof,
  ): Iterable<WorkItemEvent> {
    this.requireRootOwner(input.workItemId, binding, proof, "work.history.list");
    return this.deps.storage.iterateRecentHistory(input);
  }

  reportResult(input: WorkItemResultInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
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
    return this.targetMutation("work.result", input, binding, proof, input.state, result, reportedAt);
  }

  cancel(input: WorkItemCancelInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
    const updatedAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.cancel",
      proof,
      input.idempotencyKey,
      fingerprint,
      updatedAt,
    );
    if (replay) return replay;
    const item = this.requireVisibleItem(input.workItemId, binding, false);
    const canCancel = item.kind === "root"
      ? item.rootSessionId === binding.actorSessionId
        && item.creatorSessionId === binding.actorSessionId
        && item.targetSessionId === binding.actorSessionId
      : item.creatorSessionId === binding.actorSessionId;
    if (!canCancel || !isWorkItemActive(item.state)) {
      throw new WorkItemAuthorityError("Only the root owner or delegated creator can cancel its active Work Item.", {
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
      proof,
    });
  }

  restoreRoot(input: RootWorkItemRestoreInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItem {
    const createdAt = this.deps.currentTimestamp();
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      "work.restore",
      proof,
      input.idempotencyKey,
      fingerprint,
      createdAt,
    );
    if (replay) return replay;
    const predecessor = this.requireRootOwner(input.predecessorWorkItemId, binding);
    return this.deps.storage.createRootSuccessor({
      id: this.deps.createWorkItemId(),
      predecessorWorkItemId: predecessor.id,
      rootSessionId: predecessor.rootSessionId,
      goal: input.goal,
      scope: input.scope,
      completionCriteria: input.completionCriteria,
      authority: input.authority,
      sourceIdentity: { ...input.sourceIdentity },
      principalSessionId: binding.actorSessionId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      createdAt,
      expiresAt: resolveIdempotencyExpiresAt(createdAt),
      proof,
    });
  }

  get(workItemId: string, binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): WorkItem {
    return this.requireVisibleItem(workItemId, binding, true, proof, "work.get");
  }

  list(input: WorkItemListInput, binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): WorkItem[] {
    return Array.from(this.iterateList(input, this.resolveListScope(binding, proof), proof));
  }

  getRootWorkItem(sessionId: string, binding: ResolvedAgentRuntimeBinding): RootWorkItem | null {
    if (binding.actorSessionId !== sessionId) {
      throw new WorkItemAuthorityError("Root WorkItem lookup requires the root Session actor.");
    }
    const candidates: RootWorkItem[] = [];
    let afterSequence: number | null = null;
    for (;;) {
      const page = this.list({
        creatorSessionId: sessionId,
        targetSessionId: sessionId,
        afterSequence,
        limit: WORK_ITEM_MAX_LIST_LIMIT,
      }, binding);
      if (page.length === 0) break;
      for (const item of page) {
        if (
          isRootWorkItem(item)
          && item.rootSessionId === sessionId
          && item.creatorSessionId === sessionId
          && item.targetSessionId === sessionId
          && item.parentWorkItemId === null
        ) {
          candidates.push(item);
        }
      }
      const lastSequence = page[page.length - 1]?.sequence;
      if (lastSequence === undefined || lastSequence <= (afterSequence ?? 0)) {
        throw new Error("Work Item list pagination did not advance.");
      }
      afterSequence = lastSequence;
      if (page.length < WORK_ITEM_MAX_LIST_LIMIT) break;
    }
    if (candidates.length === 0) return null;
    const activeCandidates = candidates.filter((item) => isWorkItemActive(item.state));
    if (activeCandidates.length > 1) {
      throw new Error("A root Session must have exactly one self-owned Root WorkItem.");
    }
    return activeCandidates[0] ?? candidates[candidates.length - 1] ?? null;
  }

  resolveListScope(binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): WorkItemListScope {
    const actor = this.requireSession(binding.actorSessionId);
    if (proof && isAgentMutationProof(proof)) {
      this.requireAgentProof(proof, binding);
      if (proof.resolvedScope.rootSessionId !== actor.rootSessionId) {
        throw new WorkItemAuthorityError("The Work Item authority proof belongs to another root.", {
          actorSessionId: actor.sessionId,
        });
      }
      const visibility = proof.resolvedScope.relation === "root_member"
        ? "root"
        : proof.resolvedScope.relation === "assigned"
          ? "target"
          : proof.resolvedScope.relation === "created"
            ? "creator"
            : "actor";
      return {
        rootSessionId: proof.resolvedScope.rootSessionId,
        actorSessionId: actor.sessionId,
        visibility,
      };
    }
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    return {
      rootSessionId: actorBinding.rootSessionId,
      actorSessionId: actor.sessionId,
      visibility: actorBinding.rootSessionId === actor.sessionId
        && actorBinding.parentSessionId === null
        && actorBinding.delegationDepth === 0
        ? "root"
        : "actor",
    };
  }

  iterateList(
    input: WorkItemListInput,
    scope: WorkItemListScope,
    proof?: MutationAuthorityProof,
  ): Iterable<WorkItem> {
    if (proof && isAgentMutationProof(proof)) this.requireListProof(proof, scope);
    return this.deps.storage.iteratePage({
      rootSessionId: scope.rootSessionId,
      visibleSessionId: scope.actorSessionId,
      canSeeRoot: scope.visibility === "root",
      ...(scope.visibility === "creator"
        ? { creatorSessionId: scope.actorSessionId }
        : input.creatorSessionId === undefined ? {} : { creatorSessionId: input.creatorSessionId }),
      ...(scope.visibility === "target"
        ? { targetSessionId: scope.actorSessionId }
        : input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
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
    const allowed = item.kind === "root"
      ? item.creatorSessionId === actor.sessionId
        && item.targetSessionId === actor.sessionId
        && target.sessionId === actor.sessionId
      : item.targetSessionId === target.sessionId
        && (item.creatorSessionId === actor.sessionId || item.targetSessionId === actor.sessionId)
        && (actor.sessionId === target.sessionId
          || targetBinding.parentSessionId === actor.sessionId
          || actorBinding.parentSessionId === target.sessionId);
    if (
      item.rootSessionId !== actorBinding.rootSessionId
      || item.rootSessionId !== targetBinding.rootSessionId
      || !isWorkItemActive(item.state)
      || !allowed
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

  getAggregation(input: WorkItemAggregationGetInput, binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): WorkItemAggregationSummary {
    this.requireAggregationParent(input.parentWorkItemId, binding, true, proof, "work.aggregation.get");
    return this.deps.storage.getAggregationSummary(input.parentWorkItemId);
  }

  listAggregation(input: WorkItemAggregationListInput, binding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof): WorkItemAggregationListItem[] {
    this.requireAggregationParent(input.parentWorkItemId, binding, true, proof, "work.aggregation.list");
    return this.deps.storage.listAggregationItems(input);
  }

  decideAggregation(input: WorkItemAggregationDecisionInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): WorkItemAggregationDecision {
    const decidedAt = this.deps.currentTimestamp();
    const requestFingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveAggregationIdempotency(
      "work.aggregation.decide",
      proof,
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
      proof,
    });
  }

  retryAggregation(input: WorkItemAggregationRetryInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): { decision: WorkItemAggregationDecision; replacement: WorkItem } {
    const decidedAt = this.deps.currentTimestamp();
    const requestFingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveAggregationIdempotency(
      "work.aggregation.retry",
      proof,
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
    if (targetBinding.parentSessionId !== actor.sessionId || targetBinding.rootSessionId !== actorBinding.rootSessionId) {
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
        kind: "delegated",
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
      proof,
    });
  }

  private targetMutation(
    operation: "work.transition" | "work.result",
    input: WorkItemTransitionInput | WorkItemResultInput,
    binding: ResolvedAgentRuntimeBinding,
    proof: MutationAuthorityProof,
    state: WorkItemState,
    result: WorkItemResult | null,
    updatedAt = this.deps.currentTimestamp(),
  ): WorkItem {
    const fingerprint = fingerprintMutation(input, binding.actorSessionId);
    const replay = this.deps.storage.resolveIdempotency(
      operation,
      proof,
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
      proof,
    });
  }

  private requireAggregationActor(parentWorkItemId: string, binding: ResolvedAgentRuntimeBinding): WorkItem {
    const parent = this.requireAggregationParent(parentWorkItemId, binding, false);
    if (parent.targetSessionId !== binding.actorSessionId) {
      throw new WorkItemAuthorityError("Only the parent target Session can mutate its aggregation.", {
        parentWorkItemId,
        actorSessionId: binding.actorSessionId,
      });
    }
    return parent;
  }

  private requireAggregationParent(
    parentWorkItemId: string,
    binding: ResolvedAgentRuntimeBinding,
    allowRootVisibility: boolean,
    proof?: MutationAuthorityProof,
    operation?: "work.aggregation.get" | "work.aggregation.list",
  ): WorkItem {
    const parent = this.requireVisibleItem(parentWorkItemId, binding, allowRootVisibility, proof, operation);
    if (parent.kind !== "delegated") {
      throw new WorkItemAggregationConflictError(
        "WORK_ITEM_AGGREGATION_PARENT_INVALID",
        "Only a delegated Work Item can own an aggregation.",
        { parentWorkItemId },
      );
    }
    return parent;
  }

  private requireRootOwner(
    workItemId: string,
    binding: ResolvedAgentRuntimeBinding,
    proof?: MutationAuthorityProof,
    operation?: "work.history.list",
  ): WorkItem {
    const item = this.requireVisibleItem(workItemId, binding, false, proof, operation);
    if (
      item.kind !== "root"
      || item.rootSessionId !== binding.actorSessionId
      || item.creatorSessionId !== binding.actorSessionId
      || item.targetSessionId !== binding.actorSessionId
    ) {
      throw new WorkItemAuthorityError("Only the self-owning root Session can mutate or inspect Root Work Item history.", {
        workItemId,
        actorSessionId: binding.actorSessionId,
      });
    }
    return item;
  }

  private requireVisibleItem(
    workItemId: string,
    binding: ResolvedAgentRuntimeBinding,
    allowRootCoordinator: boolean,
    proof?: MutationAuthorityProof,
    operation?: "work.get" | "work.history.list" | "work.aggregation.get" | "work.aggregation.list",
  ): WorkItem {
    const item = this.deps.storage.get(workItemId);
    if (!item) throw new WorkItemNotFoundError(workItemId);
    const actor = this.requireSession(binding.actorSessionId);
    if (proof && isAgentMutationProof(proof)) {
      this.requireAgentProof(proof, binding, operation);
      const relations = new Set<string>();
      if (item.targetSessionId === actor.sessionId) relations.add("assigned");
      if (item.creatorSessionId === actor.sessionId) relations.add("created");
      if (
        item.kind === "root"
        && item.rootSessionId === actor.sessionId
        && item.creatorSessionId === actor.sessionId
        && item.targetSessionId === actor.sessionId
      ) relations.add("owned_root");
      if (
        item.rootSessionId === actor.rootSessionId
        && actor.rootSessionId === actor.sessionId
        && actor.parentSessionId === null
        && actor.delegationDepth === 0
      ) relations.add("root_member");
      const scope = proof.resolvedScope;
      if (
        scope.resourceKind !== "work_item"
        || scope.resourceId !== item.id
        || scope.rootSessionId !== item.rootSessionId
        || scope.ownerId !== item.targetSessionId
        || !relations.has(scope.relation)
      ) {
        throw new WorkItemAuthorityError("The Work Item authority proof does not match the canonical resource scope.", {
          workItemId,
          actorSessionId: actor.sessionId,
        });
      }
      return item;
    }
    const actorBinding = requireSessionRoleBinding(actor.sessionId, actor);
    const visible = item.rootSessionId === actorBinding.rootSessionId && (
      item.creatorSessionId === actor.sessionId
      || item.targetSessionId === actor.sessionId
      || (allowRootCoordinator
        && actorBinding.rootSessionId === actor.sessionId
        && actorBinding.parentSessionId === null
        && actorBinding.delegationDepth === 0)
    );
    if (!visible) {
      throw new WorkItemAuthorityError("The actor Session cannot access this Work Item.", {
        workItemId,
        actorSessionId: actor.sessionId,
      });
    }
    return item;
  }

  private requireAgentProof(
    proof: MutationAdmissionProof,
    binding: ResolvedAgentRuntimeBinding,
    operation?: "work.get" | "work.history.list" | "work.aggregation.get" | "work.aggregation.list",
  ): void {
    if (
      proof.principal.actorSessionId !== binding.actorSessionId
      || (operation !== undefined && (proof.operation !== operation || proof.action !== operation))
    ) {
      throw new WorkItemAuthorityError("The Work Item authority proof does not match the actor or operation.", {
        actorSessionId: binding.actorSessionId,
      });
    }
  }

  private requireListProof(
    proof: MutationAdmissionProof,
    scope: WorkItemListScope,
  ): void {
    const resolvedScope = proof.resolvedScope;
    const expectedVisibility = resolvedScope.relation === "root_member" ? "root" : "actor";
    if (
      proof.operation !== "work.list"
      || proof.action !== "work.list"
      || proof.principal.actorSessionId !== scope.actorSessionId
      || resolvedScope.resourceKind !== "work_item"
      || resolvedScope.resourceId !== null
      || resolvedScope.rootSessionId !== scope.rootSessionId
      || resolvedScope.ownerId !== scope.actorSessionId
      || (resolvedScope.relation !== "root_member" && resolvedScope.relation !== "creator_or_target")
      || scope.visibility !== expectedVisibility
    ) {
      throw new WorkItemAuthorityError("The Work Item list authority proof does not match the requested scope.", {
        actorSessionId: scope.actorSessionId,
      });
    }
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
