import { isDeepStrictEqual } from "node:util";
import { normalizeSessionTurnClientRequestId, normalizeSessionTurnSubmitSource, type ComposerPreview, type RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import { captureSessionExecutionOptions, validateSessionExecutionOptions, type SessionExecutionOptions, type SessionMessageExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionOperationRequest } from "../../src-shared/session/session-management-contract.js";
import { getSandboxOptionsForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import type { QueuedSessionTurnEditRequest, UpdateQueuedSessionTurnRequest, ReorderQueuedSessionTurnsRequest, SessionTurnQueueOwner, SessionTurnQueueStore, SessionTurnQueueOrigin, SessionTurnQueueCapturedInput, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import type { SessionTurnQueueService } from "../session/session-turn-queue-service.js";

export type MainSessionTurnQueueFacadeDeps = {
  assertActive(): void;
  assertAccepting(): void;
  getSession(sessionId: string): Promise<Session | null>;
  getSessionForCoordination?(target: SessionTurnQueueOwner & { kind: "main" | "auxiliary" }): Promise<Session | null>;
  getAppSettings(): Promise<AppSettings>;
  validateWorkspace(session: Session): Promise<void>;
  validateProvider(session: Session): Promise<{ provider: ModelCatalogProvider }>;
  preview(session: Session, userMessage: string): Promise<ComposerPreview>;
  store: SessionTurnQueueStore;
  service: SessionTurnQueueService;
  getUnreleasedSourceTurnIds?(): readonly string[];
};

export class SessionTurnQueuePreflightRejectedError extends Error {}

export class MainSessionTurnQueueFacade {
  private readonly acceptanceLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: MainSessionTurnQueueFacadeDeps) {}

  async enqueueSessionTurn(sessionId: string, input: RunSessionTurnRequest & { incarnationId: string }, origin?: SessionTurnQueueOrigin, assertActorCurrent?: () => void | Promise<void>) {
    return this.withAcceptanceLock(sessionId, async () => this.projectSourceRelease(await this.accept(sessionId, input, origin, assertActorCurrent)));
  }

  async enqueueSessionMessage(input: SessionOperationRequest<"enqueue">, origin: SessionTurnQueueOrigin, assertActorCurrent: () => void | Promise<void>) {
    const requested: SessionMessageExecutionOptions = {
      approvalMode: input.approvalMode,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.codexSandboxMode === undefined ? {} : { codexSandboxMode: input.codexSandboxMode }),
    };
    return this.withAcceptanceLock(input.target.sessionId, async () => this.projectSourceRelease(await this.accept(input.target.sessionId, {
      incarnationId: input.target.incarnationId, clientRequestId: input.requestId, userMessage: input.message, submitSource: "composer",
    }, { ...origin, deliveryTiming: input.deliveryTiming ?? "immediate", requestedExecutionOptions: requested }, assertActorCurrent, requested)));
  }

  private projectSourceRelease<T extends SessionTurnQueueReceipt | null>(receipt: T): T {
    const origin = receipt?.accepted?.origin;
    return receipt && receipt.state === "queued" && origin?.deliveryTiming === "after_source_turn"
      && this.deps.getUnreleasedSourceTurnIds?.().includes(origin.actorTurnId!)
      ? { ...receipt, sourceTurnPendingRelease: true } : receipt;
  }

  private async accept(sessionId: string, input: Omit<RunSessionTurnRequest, "executionOptions"> & { incarnationId: string; executionOptions?: SessionExecutionOptions }, origin?: SessionTurnQueueOrigin, assertActorCurrent?: () => void | Promise<void>, requested?: SessionMessageExecutionOptions) {
    await assertActorCurrent?.();
    const session = await this.readSession(sessionId);
    const owner = this.owner(session);
    let acceptedOrigin: SessionTurnQueueOrigin = origin ? structuredClone(origin) : { kind: "gui", operation: "send", targetSessionId: owner.sessionId, targetIncarnationId: owner.incarnationId };
    if (acceptedOrigin.targetSessionId !== owner.sessionId || acceptedOrigin.targetIncarnationId !== owner.incarnationId
      || acceptedOrigin.operation !== "send" || !["gui", "session"].includes(acceptedOrigin.kind)
      || (acceptedOrigin.kind === "session" && (!acceptedOrigin.actorSessionId?.trim() || !acceptedOrigin.actorIncarnationId?.trim() || !acceptedOrigin.actorTurnId?.trim()))) {
      throw new Error("The queue origin does not identify the actual actor and target.");
    }
    if (!input || input.incarnationId !== owner.incarnationId) throw new Error("The Session identity changed. Reopen it before sending.");
    const requestId = normalizeSessionTurnClientRequestId(input.clientRequestId);
    const source = normalizeSessionTurnSubmitSource(input.submitSource);
    if (!requestId || !source || typeof input.userMessage !== "string" || !input.userMessage.trim()) {
      throw new Error("A message, request identity, and submit source are required.");
    }
    const previous = await this.deps.store.getReceipt(owner, requestId);
    this.deps.assertActive();
    let executionOptions = input.executionOptions;
    if (requested) {
      if (previous) {
        const saved = previous.accepted?.origin;
        if (!saved || saved.kind !== "session" || saved.actorKind !== acceptedOrigin.actorKind
          || saved.actorSessionId !== acceptedOrigin.actorSessionId || saved.actorIncarnationId !== acceptedOrigin.actorIncarnationId
          || (saved.deliveryTiming ?? "immediate") !== acceptedOrigin.deliveryTiming
          || !isDeepStrictEqual(saved.requestedExecutionOptions, requested)) {
          throw new SessionTurnQueuePreflightRejectedError("This request identity was already used with different input or actor; query its receipt for the original acceptance.");
        }
        acceptedOrigin = saved;
        executionOptions = previous.accepted!.request.executionOptions;
      } else {
        executionOptions = { ...captureSessionExecutionOptions(session), ...requested };
      }
    }
    if (!executionOptions || typeof executionOptions !== "object") throw new Error("Turn execution options are required.");
    const request: RunSessionTurnRequest & { clientRequestId: string } = {
      userMessage: input.userMessage.trim(),
      clientRequestId: requestId,
      submitSource: source,
      executionOptions: captureSessionExecutionOptions(executionOptions),
      ...(input.auxiliaryDraftIncarnation === undefined ? {} : { auxiliaryDraftIncarnation: input.auxiliaryDraftIncarnation }),
      ...(input.auxiliaryDraftDurableRevision === undefined ? {} : { auxiliaryDraftDurableRevision: input.auxiliaryDraftDurableRevision }),
      ...(input.displayAnchorParentMessageCount === undefined ? {} : { displayAnchorParentMessageCount: input.displayAnchorParentMessageCount }),
    };
    if (previous) {
      if (!previous.accepted) throw new Error("The original queue acceptance input is unavailable; query its receipt instead.");
      if (!isDeepStrictEqual(previous.accepted.request, request) || !isDeepStrictEqual(previous.accepted.origin, acceptedOrigin)) throw new SessionTurnQueuePreflightRejectedError("This request identity was already used with different input or actor.");
      await assertActorCurrent?.();
      this.deps.service.reconcileKnownReceipt(previous);
      return previous;
    }
    let prepared: SessionTurnQueueCapturedInput;
    try {
      this.deps.assertAccepting();
      await assertActorCurrent?.();
      if (request.auxiliaryDraftIncarnation !== undefined && (typeof request.auxiliaryDraftIncarnation !== "string" || !request.auxiliaryDraftIncarnation.trim())) throw new Error("The Auxiliary draft identity is invalid.");
      if (request.auxiliaryDraftDurableRevision !== undefined && (!Number.isSafeInteger(request.auxiliaryDraftDurableRevision) || request.auxiliaryDraftDurableRevision < 0)) throw new Error("The Auxiliary draft revision is invalid.");
      if (request.displayAnchorParentMessageCount !== undefined && (!Number.isSafeInteger(request.displayAnchorParentMessageCount) || request.displayAnchorParentMessageCount < 0)) throw new Error("The Auxiliary display anchor is invalid.");
      if (requested) {
        const sandbox = getSandboxOptionsForProvider(session.provider);
        if (sandbox.length === 0 ? requested.codexSandboxMode !== undefined : !sandbox.some((option) => option.value === requested.codexSandboxMode)) {
          throw new Error("Codex messages require codexSandboxMode; other Providers do not accept this unsupported setting.");
        }
      }
      prepared = await this.prepareExecution(session, request, () => this.readSession(sessionId), true, requested !== undefined);
      await assertActorCurrent?.();
    } catch (error) {
      // Canonical lookup proved absence while this Session's intake was locked.
      // No queue mutation was issued, so this reply can safely reject acceptance.
      throw new SessionTurnQueuePreflightRejectedError(error instanceof Error ? error.message : "Turn preflight failed.", { cause: error });
    }
    return this.deps.service.enqueue(owner, {
      ...prepared,
      origin: acceptedOrigin,
    }, assertActorCurrent);
  }

  async prepareCoordinationDelivery(target: SessionTurnQueueOwner & { kind: "main" | "auxiliary" }, operationId: string): Promise<SessionTurnQueueCapturedInput> {
    this.deps.assertAccepting();
    const requestId = normalizeSessionTurnClientRequestId(operationId);
    if (!requestId || !this.deps.getSessionForCoordination) throw new Error("Coordination delivery preparation is unavailable or invalid.");
    const read = async () => {
      const session = await this.deps.getSessionForCoordination!(target);
      this.deps.assertActive();
      if (!session || session.id !== target.sessionId || getSessionIncarnationId(session) !== target.incarnationId || session.accessMode !== "active") throw new Error("The Coordination delivery target changed or is unavailable.");
      return session;
    };
    const session = await read();
    return this.prepareExecution(session, { clientRequestId: requestId, userMessage: "", submitSource: "retry",
      executionOptions: captureSessionExecutionOptions(session) }, read, false);
  }

  private async prepareExecution(session: Session, request: SessionTurnQueueCapturedInput["request"], readCurrent: () => Promise<Session>, resolveAttachments: boolean, validateMessageSelection = false): Promise<SessionTurnQueueCapturedInput> {
    this.deps.assertAccepting();
    await this.deps.validateWorkspace(session);
    const catalog = await this.deps.validateProvider(session);
    const executionOptions = validateSessionExecutionOptions(request.executionOptions, catalog.provider);
    if (validateMessageSelection) {
      const model = catalog.provider.models.find((entry) => entry.id === executionOptions.model);
      if (!model) throw new Error("The selected message model is not in the recipient's discovered model list.");
      if (executionOptions.reasoningEffort !== "" && !model.reasoningEfforts.includes(executionOptions.reasoningEffort)) {
        throw new Error("The selected message depth is not supported by this model.");
      }
    }
    const preview = resolveAttachments ? await this.deps.preview(session, request.userMessage) : { attachments: [], errors: [] };
    if (preview.errors.length) throw new Error(preview.errors[0]);
    assertModelEnabled((await this.deps.getAppSettings()).modelAvailability, session.provider, executionOptions.model);
    const current = await readCurrent();
    if (getSessionIncarnationId(current) !== getSessionIncarnationId(session) || current.provider !== session.provider || current.workspacePath !== session.workspacePath) throw new Error("The Session identity changed during queue acceptance.");
    this.deps.assertAccepting();
    return { request: { ...request, executionOptions }, attachments: preview.attachments, provider: session.provider, workspacePath: session.workspacePath };
  }

  async getSessionTurnQueueReceipt(sessionId: string, requestId: string, incarnationId?: string) {
    const normalizedId = normalizeSessionTurnClientRequestId(requestId);
    if (!normalizedId) throw new Error("The request identity is invalid.");
    const owner = this.owner(await this.readSession(sessionId));
    if (incarnationId !== undefined && incarnationId !== owner.incarnationId) throw new Error("The Session identity changed.");
    const receipt = await this.deps.store.getReceipt(owner, normalizedId);
    this.deps.assertActive();
    if (receipt) this.deps.service.reconcileKnownReceipt(receipt);
    return this.projectSourceRelease(receipt);
  }

  async listSessionTurnQueue(sessionId: string) {
    const receipts = await this.deps.store.listActive(this.owner(await this.readSession(sessionId)));
    return receipts.map((receipt) => this.projectSourceRelease(receipt));
  }

  async listSessionTurnQueueReceipts(sessionId: string, options?: { cursor?: number; limit?: number }) {
    const page = await this.deps.store.listReceipts(this.owner(await this.readSession(sessionId)), options);
    return { ...page, receipts: page.receipts.map((receipt) => this.projectSourceRelease(receipt)) };
  }

  async cancelQueuedSessionTurn(sessionId: string, id: string) {
    this.deps.assertAccepting();
    return this.deps.service.cancelQueued(this.owner(await this.readSession(sessionId)), this.requireId(id));
  }

  async getSessionTurnReceipt(owner: SessionTurnQueueOwner, id: string) {
    await this.readEditSession(owner);
    const receipt = await this.deps.store.getReceiptById(owner, this.requireId(id));
    this.deps.assertActive();
    if (receipt) this.deps.service.reconcileKnownReceipt(receipt);
    return receipt;
  }

  async cancelSessionTurnReceipt(owner: SessionTurnQueueOwner, id: string, assertAuthorized?: () => void | Promise<void>) {
    this.deps.assertAccepting();
    await this.readEditSession(owner);
    const receipt = await this.deps.service.cancelQueued(owner, this.requireId(id), assertAuthorized);
    return { outcome: receipt.state === "canceled" ? "applied" as const : "not-applied" as const, receipt };
  }

  beginQueuedSessionTurnEdit(sessionId: string, input: QueuedSessionTurnEditRequest) {
    this.deps.assertAccepting();
    const owner = this.editOwner(sessionId, input);
    return this.deps.service.beginQueuedEdit(owner, input.id, async () => {
      await this.readEditSession(owner);
    });
  }

  updateQueuedSessionTurn(sessionId: string, input: UpdateQueuedSessionTurnRequest) {
    this.deps.assertAccepting();
    const owner = this.editOwner(sessionId, input);
    return this.deps.service.updateQueued(owner, input.id, async (receipt) => {
      if (typeof input.userMessage !== "string" || !input.userMessage.trim()) throw new Error("A queued message is required.");
      const session = await this.readEditSession(owner);
      if (session.provider !== receipt.captured.provider || session.workspacePath !== receipt.captured.workspacePath) throw new Error("The queued Session execution context changed.");
      await this.deps.validateWorkspace(session);
      await this.deps.validateProvider(session);
      const userMessage = input.userMessage.trim();
      const preview = await this.deps.preview(session, userMessage);
      if (preview.errors.length) throw new Error(preview.errors[0]);
      const current = await this.readEditSession(owner);
      if (current.provider !== session.provider || current.workspacePath !== session.workspacePath) throw new Error("The Session execution context changed during editing.");
      this.deps.assertAccepting();
      return { userMessage, attachments: preview.attachments };
    });
  }

  async cancelQueuedSessionTurnEdit(sessionId: string, input: QueuedSessionTurnEditRequest): Promise<void> {
    const owner = this.editOwner(sessionId, input);
    await this.readEditSession(owner);
    await this.deps.service.cancelQueuedEdit(owner, input.id);
  }

  private editOwner(sessionId: string, input: QueuedSessionTurnEditRequest): SessionTurnQueueOwner {
    if (typeof sessionId !== "string" || !sessionId.trim() || !input || typeof input.incarnationId !== "string" || !input.incarnationId.trim()) throw new Error("A Session identity is required.");
    this.requireId(input.id);
    return { sessionId, incarnationId: input.incarnationId };
  }

  private async readEditSession(owner: SessionTurnQueueOwner): Promise<Session> {
    const session = await this.readSession(owner.sessionId);
    if (getSessionIncarnationId(session) !== owner.incarnationId) throw new Error("The Session identity changed. Reopen it before editing.");
    return session;
  }

  async reorderQueuedSessionTurns(sessionId: string, input: ReorderQueuedSessionTurnsRequest) {
    this.deps.assertAccepting();
    const owner = this.owner(await this.readSession(sessionId));
    if (!input || input.incarnationId !== owner.incarnationId) throw new Error("The Session identity changed. Reopen it before reordering.");
    const result = await this.deps.service.reorderQueued(owner, input.expectedQueuedIds, input.queuedIds);
    this.deps.assertActive();
    return { ...result, receipts: result.receipts.map((receipt) => this.projectSourceRelease(receipt)) };
  }

  async releaseInterruptedSessionTurn(sessionId: string, id: string) {
    this.deps.assertAccepting();
    return this.deps.service.releaseInterrupted(this.owner(await this.readSession(sessionId)), this.requireId(id));
  }

  async sendQueuedSessionInput(sessionId: string, id: string, expectedTurnId: string) {
    this.deps.assertAccepting();
    const owner = this.owner(await this.readSession(sessionId));
    if (typeof expectedTurnId !== "string" || !expectedTurnId.trim()) throw new Error("A current Turn identity is required.");
    this.deps.assertAccepting();
    return this.deps.service.sendQueuedInput(owner, this.requireId(id), expectedTurnId);
  }

  private async readSession(sessionId: string): Promise<Session> {
    this.deps.assertActive();
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("A Session identity is required.");
    const session = await this.deps.getSession(sessionId);
    this.deps.assertActive();
    if (!session || session.accessMode !== "active") throw new Error("The Session is unavailable or read-only.");
    return session;
  }

  private owner(session: Session): SessionTurnQueueOwner {
    return { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
  }

  private requireId(id: string): string {
    if (typeof id !== "string" || !id.trim()) throw new Error("A queue item identity is required.");
    return id;
  }

  private withAcceptanceLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.acceptanceLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run);
    const released = next.then(() => undefined, () => undefined);
    this.acceptanceLocks.set(sessionId, released);
    void released.then(() => {
      if (this.acceptanceLocks.get(sessionId) === released) this.acceptanceLocks.delete(sessionId);
    });
    return next;
  }
}
