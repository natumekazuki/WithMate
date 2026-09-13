import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Delegation, DelegationCreateInput, DelegationGetInput, DelegationItem, DelegationListInput, DelegationMutationInput, DelegationRetryInput } from "../src/delegation.js";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import type { SessionRuntimeOperation, SessionRuntimeResultByOperation, SessionRuntimeResultEnvelope, SessionRuntimeError } from "../src/session-external-runtime-contract.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import { DelegationStorage, DelegationRevisionError } from "./delegation-storage.js";

export class DelegationOperationError extends Error {
  constructor(readonly error: SessionRuntimeError["error"]) { super(error.message); }
}
const terminal = (state: string) => !["queued", "running"].includes(state);
const stopped = (state: string) => ["cancelled", "compensated", "cancelling", "compensating"].includes(state);

export class DelegationService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: {
    storage: DelegationStorage;
    authorizeControl(binding: ResolvedAgentRuntimeBinding, operation: SessionRuntimeOperation, input: unknown): void;
    execute(operation: SessionRuntimeOperation, input: unknown, binding: ResolvedAgentRuntimeBinding, compensation?: { executionId: string | null }): Promise<SessionRuntimeResultEnvelope | SessionRuntimeError>;
    executeCreatedRoot?(delegationId: string, itemIndex: number, operation: SessionRuntimeOperation, input: unknown, binding: ResolvedAgentRuntimeBinding): Promise<SessionRuntimeResultEnvelope | SessionRuntimeError>;
    currentTimestamp?: () => string;
  }) {}

  create(binding: ResolvedAgentRuntimeBinding, input: DelegationCreateInput, proof: MutationAuthorityProof): Promise<Delegation> {
    return this.serial(async () => {
      const actor = binding.actorSessionId;
      const existing = this.deps.storage.findByIdempotencyKey(actor, input.idempotencyKey);
      if (existing) {
        if (!isDeepStrictEqual(JSON.parse(this.deps.storage.getRequestJson(existing.id, actor)), input)) this.fail("IDEMPOTENCY_CONFLICT", "The key belongs to another delegation request.");
        return existing;
      }
      const row = this.deps.storage.create({
        id: randomUUID(), actorSessionId: actor, idempotencyKey: input.idempotencyKey, request: input, proof,
        state: "preparing", items: input.items.map((_, index) => ({ index, sessionId: null, workItemId: null, executionId: null,
          createdSession: false, createdWorkItem: false, state: "preparing", pendingStep: "session", effect: "not_applied", error: null })),
        recoveryActions: ["retry", "cancel", "compensate"], createdAt: this.now(),
      });
      return this.advance(binding, row, input.dispatch);
    });
  }

  get(binding: ResolvedAgentRuntimeBinding, input: DelegationGetInput): Promise<Delegation> {
    return this.serial(() => this.refresh(binding, this.deps.storage.get(input.delegationId, binding.actorSessionId)));
  }
  list(binding: ResolvedAgentRuntimeBinding, input: DelegationListInput) {
    return this.serial(async () => {
      const result = this.deps.storage.list(binding.actorSessionId, input.limit, input.cursor);
      return { ...result, items: await Promise.all(result.items.map((item) => this.refresh(binding, item))) };
    });
  }
  retry(binding: ResolvedAgentRuntimeBinding, input: DelegationRetryInput, proof: MutationAuthorityProof) {
    return this.mutate(binding, "delegation.retry", input, proof, async (row) => {
      if (stopped(row.state)) this.fail("DELEGATION_STATE_CONFLICT", "A stopped delegation cannot dispatch. Reuse its resources in a new delegation.");
      const pending = this.deps.storage.getInternal(row.id, binding.actorSessionId).pending;
      if (input.dispatch === "enqueue" && pending && ["session.create", "work.create", "work.aggregation.retry"].includes(pending.operation)) {
        row = await this.advance(binding, row, "prepare");
        if (row.state === "recovery_required") return row;
      }
      return this.advance(binding, row, input.dispatch);
    });
  }
  cancel(binding: ResolvedAgentRuntimeBinding, input: DelegationMutationInput, proof: MutationAuthorityProof) {
    return this.mutate(binding, "delegation.cancel", input, proof, (row) => this.cleanup(binding, row, false));
  }
  compensate(binding: ResolvedAgentRuntimeBinding, input: DelegationMutationInput, proof: MutationAuthorityProof) {
    return this.mutate(binding, "delegation.compensate", input, proof, (row) => this.cleanup(binding, row, true));
  }

  private mutate(binding: ResolvedAgentRuntimeBinding, operation: string, input: DelegationMutationInput, proof: MutationAuthorityProof, action: (row: Delegation) => Promise<Delegation>) {
    return this.serial(async () => {
      const actor = binding.actorSessionId;
      let row = this.deps.storage.get(input.delegationId, actor);
      const previous = this.deps.storage.getInternal(row.id, actor).lastMutation;
      const pending = this.deps.storage.getInternal(row.id, actor).pending;
      const prior = previous?.prior ?? [];
      const known = [previous, ...prior].find((entry) => entry && (entry.input as DelegationMutationInput).idempotencyKey === input.idempotencyKey);
      if (known && (known.operation !== operation || !isDeepStrictEqual(known.input, input))) this.fail("IDEMPOTENCY_CONFLICT", "The key belongs to another delegation mutation.");
      if (known && known !== previous) throw new DelegationRevisionError(row.id, input.expectedRevision, row.revision);
      if (known === previous && previous?.result) return previous.result;
      const nextPrior = previous && known !== previous ? [...prior, { operation: previous.operation, input: previous.input }] : prior;
      if (operation === "delegation.retry" && previous && ["delegation.cancel", "delegation.compensate"].includes(previous.operation)) this.fail("DELEGATION_STATE_CONFLICT", "Cancellation has been requested. Continue cleanup or explicitly reuse the resources.");
      if (operation === "delegation.retry" && (input as DelegationRetryInput).dispatch === "prepare" && pending?.operation === "turn.enqueue") this.fail("DELEGATION_STATE_CONFLICT", "An attempted dispatch must be resolved before returning to a prepared state.");
      const unapplied = pending && row.items[pending.itemIndex].error?.effect === "not_applied";
      if (operation !== "delegation.retry" && pending && !unapplied && ["session.create", "work.create", "work.aggregation.retry", "turn.enqueue"].includes(pending.operation)) this.fail("DELEGATION_RECOVERY_REQUIRED", "Resume the uncertain creation step before cleanup.");
      if (previous && (previous.input as DelegationMutationInput).idempotencyKey === input.idempotencyKey) {
        if (previous.operation !== operation || !isDeepStrictEqual(previous.input, input)) this.fail("IDEMPOTENCY_CONFLICT", "The key belongs to another delegation mutation.");
        if (previous.result) return previous.result;
      } else {
        if (row.revision !== input.expectedRevision) throw new DelegationRevisionError(row.id, input.expectedRevision, row.revision);
        row = this.save(binding, row, { lastMutation: { operation, input, result: null, prior: nextPrior }, proof, ...(operation !== "delegation.retry" && unapplied ? { pending: null } : {}) });
      }
      row = await action(row);
      const result = { ...row, revision: row.revision + 1, updatedAt: this.now() };
      return this.save(binding, row, { lastMutation: { operation, input, result, prior: nextPrior }, updatedAt: result.updatedAt });
    });
  }

  private async advance(binding: ResolvedAgentRuntimeBinding, initial: Delegation, dispatch: "prepare" | "enqueue") {
    let row = initial;
    const request = JSON.parse(this.deps.storage.getRequestJson(row.id, binding.actorSessionId)) as DelegationCreateInput;
    for (const [index, plan] of request.items.entries()) {
      try {
        let item = row.items[index];
        if (!item.sessionId) {
          if (plan.target.kind === "existing") {
            const session = await this.callItem(binding, row, index, "session.get", { sessionId: plan.target.sessionId });
            row = this.item(binding, row, index, { sessionId: session.sessionId, pendingStep: "work" });
          } else {
            const step = await this.step(binding, row, index, "session.create", () => ({ ...(plan.target.kind === "create" ? plan.target.session : {}), idempotencyKey: this.key(row, index, "session") }));
            row = this.item(binding, step.row, index, { sessionId: step.result.sessionId, createdSession: true, effect: "applied", pendingStep: "work" }, true);
          }
        }
        item = row.items[index];
        if (!item.workItemId) {
          if (plan.work.kind === "existing") {
            const work = await this.callItem(binding, row, index, "work.get", { workItemId: plan.work.workItemId });
            if (work.targetSessionId !== item.sessionId) this.fail("DELEGATION_TARGET_CONFLICT", "The Work Item belongs to another target Session.");
            row = this.item(binding, row, index, { workItemId: work.id, pendingStep: null, state: "prepared" });
          } else if (plan.work.kind === "root") {
            let cursor: string | undefined;
            let rootId: string | null = null;
            do {
              const page = await this.callItem(binding, row, index, "work.list", { creatorSessionId: item.sessionId!, targetSessionId: item.sessionId!, limit: 100, ...(cursor ? { cursor } : {}) });
              for (const work of page.items) if (work.kind === "root" && work.predecessorWorkItemId === null) {
                if (rootId) this.fail("DELEGATION_STATE_CONFLICT", "Multiple initial Root Work Items were found.");
                rootId = work.id;
              }
              cursor = page.nextCursor;
            } while (cursor);
            if (!rootId) this.fail("DELEGATION_STATE_CONFLICT", "The created Session has no initial Root Work Item.");
            row = this.item(binding, row, index, { workItemId: rootId, createdWorkItem: true, pendingStep: null, state: "prepared" });
          } else if (plan.work.kind === "replacement") {
            const step = await this.step(binding, row, index, "work.aggregation.retry", () => ({ ...(plan.work.kind === "replacement" ? plan.work.request : {}), targetSessionId: item.sessionId, idempotencyKey: this.key(row, index, "work") }));
            row = this.item(binding, step.row, index, { workItemId: step.result.replacement.id, createdWorkItem: true, effect: "applied", pendingStep: null, state: "prepared" }, true);
          } else {
            const step = await this.step(binding, row, index, "work.create", async () => {
              const session = await this.callItem(binding, row, index, "session.get", { sessionId: item.sessionId! });
              return { ...(plan.work.kind === "create" ? plan.work.contract : {}), targetSessionId: item.sessionId, expectedContainerRevision: session.revision, idempotencyKey: this.key(row, index, "work") };
            });
            row = this.item(binding, step.row, index, { workItemId: step.result.id, createdWorkItem: true, effect: "applied", pendingStep: null, state: "prepared" }, true);
          }
        }
        item = row.items[index];
        if (dispatch === "enqueue" && !item.executionId) {
          const step = await this.step(binding, row, index, "turn.enqueue", async () => {
            const session = await this.callItem(binding, row, index, "session.get", { sessionId: item.sessionId! });
            return { ...plan.turn, sessionId: item.sessionId, workItemId: item.workItemId, expectedContainerRevision: session.revision, idempotencyKey: this.key(row, index, "turn") };
          });
          row = this.item(binding, step.row, index, { executionId: step.result.id, effect: "applied", state: "active", pendingStep: null }, true);
        }
      } catch (error) { return this.failure(binding, row, index, error); }
    }
    return this.save(binding, row, { state: row.items.some((item) => item.executionId) ? "active" : "prepared", recoveryActions: dispatch === "enqueue" ? ["cancel", "compensate"] : ["retry", "cancel", "compensate"] });
  }

  private async cleanup(binding: ResolvedAgentRuntimeBinding, initial: Delegation, compensate: boolean) {
    let row = initial;
    const pending = this.deps.storage.getInternal(row.id, binding.actorSessionId).pending;
    if (pending && ["session.create", "work.create", "work.aggregation.retry", "turn.enqueue"].includes(pending.operation)) {
      return this.failure(binding, row, pending.itemIndex, new DelegationOperationError({ code: "DELEGATION_RECOVERY_REQUIRED", message: "Resume the uncertain creation step before cleanup.", retryable: true, effect: "indeterminate", details: {} }));
    }
    row = this.save(binding, row, { state: compensate ? "compensating" : "cancelling" });
    for (let index = row.items.length - 1; index >= 0; index--) {
      try {
        let item = row.items[index];
        if (item.state === "compensated" || (!compensate && item.state === "cancelled")) continue;
        if (item.executionId) {
          let execution = await this.callItem(binding, row, index, "turn.get", { sessionId: item.sessionId!, executionId: item.executionId });
          if (!terminal(execution.state)) {
            const step = await this.step(binding, row, index, "turn.cancel", () => ({ sessionId: item.sessionId, executionId: item.executionId, expectedRevision: execution.revision, idempotencyKey: this.key(row, index, "cancel") }));
            row = this.save(binding, step.row, { pending: null });
            execution = await this.callItem(binding, row, index, "turn.get", { sessionId: item.sessionId!, executionId: item.executionId });
          }
          if (!terminal(execution.state)) this.fail("DELEGATION_RECOVERY_REQUIRED", "Cancellation is still settling.");
          if (this.deps.storage.getInternal(row.id, binding.actorSessionId).pending?.operation === "turn.cancel") row = this.save(binding, row, { pending: null });
          if (compensate && execution.admittedAt !== null) this.fail("DELEGATION_RESOURCE_IN_USE", "Execution has started. Preserve its work and explicitly collect or reuse the resources.");
        }
        if (compensate && item.createdWorkItem && item.workItemId) {
          if (this.deps.storage.hasOtherConsumer(row.id, null, item.workItemId)) this.fail("DELEGATION_RESOURCE_ADOPTED", "Another delegation has adopted this Work Item.");
          let cursor: string | undefined;
          do {
            const page = await this.callItem(binding, row, index, "turn.list", { sessionId: item.sessionId!, limit: 100, ...(cursor ? { cursor } : {}) });
            if (page.items.some((execution) => execution.workItemId === item.workItemId && execution.id !== item.executionId)) this.fail("DELEGATION_RESOURCE_ADOPTED", "Another execution references this Work Item.");
            cursor = page.nextCursor;
          } while (cursor);
          const work = await this.callItem(binding, row, index, "work.get", { workItemId: item.workItemId });
          if (work.targetSessionId !== item.sessionId || !["pending", "canceled"].includes(work.state)) this.fail("DELEGATION_RESOURCE_IN_USE", "The Work Item has progressed or changed ownership.");
          if (work.state === "canceled" && this.deps.storage.getInternal(row.id, binding.actorSessionId).pending?.operation === "work.cancel") row = this.save(binding, row, { pending: null });
          if (work.state === "pending") {
            const step = await this.step(binding, row, index, "work.cancel", () => ({ workItemId: work.id, expectedRevision: work.revision, idempotencyKey: this.key(row, index, "work-cancel") }));
            row = this.save(binding, step.row, { pending: null });
          }
          const currentWork = await this.callItem(binding, row, index, "work.get", { workItemId: item.workItemId });
          if (!currentWork.archivedAt) {
            const step = await this.step(binding, row, index, "work.archive", () => ({ workItemId: currentWork.id, expectedRevision: currentWork.revision, reason: "Delegation compensation", idempotencyKey: this.key(row, index, "work-archive") }));
            row = this.save(binding, step.row, { pending: null });
          } else if (this.deps.storage.getInternal(row.id, binding.actorSessionId).pending?.operation === "work.archive") row = this.save(binding, row, { pending: null });
        }
        item = row.items[index];
        if (compensate && item.createdSession && item.sessionId) {
          if (this.deps.storage.hasOtherConsumer(row.id, item.sessionId, null)) this.fail("DELEGATION_RESOURCE_ADOPTED", "Another delegation has adopted this Session.");
          const manifest = await this.callItem(binding, row, index, "session.delete.manifest", { sessionId: item.sessionId });
          if (manifest.blockers.length || manifest.descendants.length || manifest.artifacts.length || manifest.budgetReservations.some((reservation) => reservation.state === "reserved")) this.fail("DELEGATION_RESOURCE_IN_USE", "The Session still has resources requiring collection or settlement.");
          const session = await this.callItem(binding, row, index, "session.get", { sessionId: item.sessionId });
          const step = await this.step(binding, row, index, "session.archive", () => ({ sessionId: item.sessionId, expectedRevision: session.revision, reason: "Delegation compensation", descendantPolicy: "retain", idempotencyKey: this.key(row, index, "session-archive") }));
          row = this.save(binding, step.row, { pending: null });
        }
        row = this.item(binding, row, index, { state: compensate ? "compensated" : "cancelled", pendingStep: null });
      } catch (error) { return this.failure(binding, row, index, error); }
    }
    return this.save(binding, row, { state: compensate ? "compensated" : "cancelled", recoveryActions: compensate ? [] : ["compensate"] });
  }

  private async step<O extends SessionRuntimeOperation>(binding: ResolvedAgentRuntimeBinding, initial: Delegation, index: number, operation: O, makeInput: () => unknown | Promise<unknown>): Promise<{ row: Delegation; result: SessionRuntimeResultByOperation[O] }> {
    let row = this.deps.storage.get(initial.id, binding.actorSessionId);
    let pending = this.deps.storage.getInternal(row.id, binding.actorSessionId).pending;
    const previousEffect = pending?.itemIndex === index ? row.items[index].error?.effect ?? "indeterminate" : "not_applied";
    try {
      if (pending) {
        if (pending.itemIndex !== index || pending.operation !== operation) this.fail("DELEGATION_RECOVERY_REQUIRED", "Another step requires recovery first.");
        if (Date.parse(this.now()) - Date.parse(pending.startedAt) >= 24 * 60 * 60 * 1000) this.fail("DELEGATION_RECOVERY_REQUIRED", "The owner's replay retention has expired. Inspect and reuse the existing resources.");
      } else {
        pending = { itemIndex: index, operation, input: await makeInput(), startedAt: this.now() };
      }
      // A crash after this save cannot prove whether the owner applied the step.
      row = this.save(binding, row, { pending, items: row.items.map((item, i) => i === index ? { ...item, error: null, pendingStep: operation, state: operation === "turn.enqueue" ? "dispatching" : item.state } : item) });
      return { row, result: await this.callItem(binding, row, index, operation, pending.input) };
    } catch (error) {
      if (previousEffect !== "not_applied" && error instanceof DelegationOperationError && error.error.effect === "not_applied") {
        throw new DelegationOperationError({ ...error.error, effect: previousEffect });
      }
      throw error;
    }
  }

  private async callItem<O extends SessionRuntimeOperation>(binding: ResolvedAgentRuntimeBinding, row: Delegation, index: number, operation: O, input: unknown): Promise<SessionRuntimeResultByOperation[O]> {
    const request = JSON.parse(this.deps.storage.getRequestJson(row.id, binding.actorSessionId)) as DelegationCreateInput;
    if (!["session.get", "work.get", "work.list", "turn.get", "turn.list", "session.delete.manifest"].includes(operation)) {
      const mutation = this.deps.storage.getInternal(row.id, binding.actorSessionId).lastMutation;
      this.deps.authorizeControl(binding, (mutation?.operation ?? "delegation.create") as SessionRuntimeOperation, mutation?.input ?? request);
    }
    if (row.items[index].createdSession && request.items[index].work.kind === "root") {
      if (!this.deps.executeCreatedRoot) this.fail("DELEGATION_RECOVERY_REQUIRED", "Created-root dispatch is unavailable.");
      const response = await this.deps.executeCreatedRoot(row.id, index, operation, input, binding);
      if ("error" in response) throw new DelegationOperationError(response.error);
      if (response.operation !== operation) this.fail("DELEGATION_RECOVERY_REQUIRED", "Unexpected created-root response.");
      return response.result as SessionRuntimeResultByOperation[O];
    }
    return this.call(binding, operation, input, operation === "work.cancel" ? { executionId: row.items[index].executionId } : undefined);
  }
  private async call<O extends SessionRuntimeOperation>(binding: ResolvedAgentRuntimeBinding, operation: O, input: unknown, compensation?: { executionId: string | null }): Promise<SessionRuntimeResultByOperation[O]> {
    const result = await this.deps.execute(operation, input, binding, compensation);
    if ("error" in result) throw new DelegationOperationError(result.error);
    if (result.operation !== operation) this.fail("DELEGATION_RECOVERY_REQUIRED", "The operation returned an unexpected response.");
    return result.result as SessionRuntimeResultByOperation[O];
  }
  private failure(binding: ResolvedAgentRuntimeBinding, original: Delegation, index: number, error: unknown) {
    const row = this.deps.storage.get(original.id, binding.actorSessionId);
    const detail = error instanceof DelegationOperationError ? error.error : { code: "DELEGATION_STEP_FAILED", message: "The delegation step requires read-back before retry.", retryable: true, effect: "indeterminate" as const, details: {} };
    const item = row.items[index];
    const internal = this.deps.storage.getInternal(row.id, binding.actorSessionId);
    const cleanup = ["delegation.cancel", "delegation.compensate"].includes(internal.lastMutation?.operation ?? "");
    const uncertainCreation = internal.pending && ["session.create", "work.create", "work.aggregation.retry", "turn.enqueue"].includes(internal.pending.operation) && detail.effect !== "not_applied";
    const expired = internal.pending && Date.parse(this.now()) - Date.parse(internal.pending.startedAt) >= 24 * 60 * 60 * 1000;
    const recoveryActions: Delegation["recoveryActions"] = uncertainCreation ? (expired ? [] : ["retry"]) : cleanup ? ["cancel", "compensate"] : ["retry", "cancel", "compensate"];
    return this.save(binding, row, { state: "recovery_required", recoveryActions,
      items: row.items.map((value, i) => i === index ? { ...value, state: "recovery_required", error: detail,
        effect: detail.effect === "indeterminate" ? "indeterminate" : item.effect === "applied" || detail.effect === "applied" ? "applied" : "not_applied" } : value) });
  }
  private async refresh(binding: ResolvedAgentRuntimeBinding, row: Delegation): Promise<Delegation> {
    if (row.state !== "active") return row;
    const projectedErrors = new Map<number, SessionRuntimeError["error"]>();
    const items = await Promise.all(row.items.map(async (item, index) => {
      if (!item.executionId || !item.sessionId || item.state === "completed") return item;
      try {
        const execution = await this.callItem(binding, row, index, "turn.get", { sessionId: item.sessionId, executionId: item.executionId });
        return { ...item, state: terminal(execution.state) ? "completed" as const : "active" as const,
          error: terminal(execution.state) && execution.state !== "completed"
            ? { code: execution.errorCode || "DELEGATION_EXECUTION_STOPPED", message: execution.reason || "The execution ended without success. Read its result before explicit reuse.", effect: "applied" as const, retryable: false, details: { executionId: execution.id } }
            : item.error };
      } catch (error) {
        projectedErrors.set(index, error instanceof DelegationOperationError ? error.error : { code: "DELEGATION_READ_FAILED", message: "Execution state is unavailable. The saved resource references are retained.", effect: "not_applied", retryable: true, details: {} });
        return item;
      }
    }));
    const state = items.every((item) => item.state === "completed") ? "completed" : "active";
    if (state !== row.state || !isDeepStrictEqual(items, row.items)) row = this.save(binding, row, { items, state });
    return { ...row, items: row.items.map((item, index) => projectedErrors.has(index) ? { ...item, error: projectedErrors.get(index)! } : item) };
  }

  private item(binding: ResolvedAgentRuntimeBinding, row: Delegation, index: number, patch: Partial<DelegationItem>, clearPending = false) {
    return this.save(binding, row, { items: row.items.map((item, i) => i === index ? { ...item, ...patch, error: null } : item), ...(clearPending ? { pending: null } : {}) });
  }
  private save(binding: ResolvedAgentRuntimeBinding, row: Delegation, patch: Omit<Partial<Parameters<DelegationStorage["update"]>[0]>, "id" | "actorSessionId" | "expectedRevision">) {
    return this.deps.storage.update({ id: row.id, actorSessionId: binding.actorSessionId, expectedRevision: row.revision, updatedAt: this.now(), ...patch });
  }
  private key(row: Delegation, index: number, step: string) { return `delegation:${row.id}:${index}:${step}`; }
  private now() { return this.deps.currentTimestamp?.() ?? new Date().toISOString(); }
  private fail(code: string, message: string): never { throw new DelegationOperationError({ code, message, effect: "not_applied", retryable: false, details: {} }); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
