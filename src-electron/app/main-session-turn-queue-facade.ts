import { isDeepStrictEqual } from "node:util";
import { normalizeSessionTurnClientRequestId, normalizeSessionTurnSubmitSource, type ComposerPreview, type RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import { captureSessionExecutionOptions, validateSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionTurnQueueOwner, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";
import type { SessionTurnQueueService } from "../session/session-turn-queue-service.js";

export type MainSessionTurnQueueFacadeDeps = {
  assertActive(): void;
  assertAccepting(): void;
  getSession(sessionId: string): Promise<Session | null>;
  validateWorkspace(session: Session): Promise<void>;
  validateProvider(session: Session, revision: number): Promise<{ provider: ModelCatalogProvider; revision: number }>;
  preview(session: Session, userMessage: string): Promise<ComposerPreview>;
  store: SessionTurnQueueStore;
  service: SessionTurnQueueService;
};

export class SessionTurnQueuePreflightRejectedError extends Error {}

export class MainSessionTurnQueueFacade {
  private readonly acceptanceLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: MainSessionTurnQueueFacadeDeps) {}

  async enqueueSessionTurn(sessionId: string, input: RunSessionTurnRequest & { incarnationId: string }) {
    return this.withAcceptanceLock(sessionId, () => this.accept(sessionId, input));
  }

  private async accept(sessionId: string, input: RunSessionTurnRequest & { incarnationId: string }) {
    const session = await this.readSession(sessionId);
    const owner = this.owner(session);
    if (!input || input.incarnationId !== owner.incarnationId) throw new Error("The Session identity changed. Reopen it before sending.");
    const requestId = normalizeSessionTurnClientRequestId(input.clientRequestId);
    const source = normalizeSessionTurnSubmitSource(input.submitSource);
    if (!requestId || !source || typeof input.userMessage !== "string" || !input.userMessage.trim()) {
      throw new Error("A message, request identity, and submit source are required.");
    }
    if (!input.executionOptions || typeof input.executionOptions !== "object") throw new Error("Turn execution options are required.");
    const request: RunSessionTurnRequest & { clientRequestId: string } = {
      userMessage: input.userMessage.trim(),
      clientRequestId: requestId,
      submitSource: source,
      executionOptions: captureSessionExecutionOptions(input.executionOptions),
    };
    const previous = await this.deps.store.getReceipt(owner, requestId);
    this.deps.assertActive();
    if (previous) {
      if (!isDeepStrictEqual(previous.captured.request, request)) throw new Error("This request identity was already used with different input.");
      this.deps.service.reconcileKnownReceipt(previous);
      return previous;
    }
    let preview: ComposerPreview;
    try {
      this.deps.assertAccepting();
      await this.deps.validateWorkspace(session);
      const catalog = await this.deps.validateProvider(session, request.executionOptions.catalogRevision);
      request.executionOptions = validateSessionExecutionOptions(request.executionOptions, catalog.provider, catalog.revision);
      preview = await this.deps.preview(session, request.userMessage);
      if (preview.errors.length) throw new Error(preview.errors[0]);
      const current = await this.readSession(sessionId);
      if (getSessionIncarnationId(current) !== owner.incarnationId || current.provider !== session.provider || current.workspacePath !== session.workspacePath) {
        throw new Error("The Session identity changed during queue acceptance.");
      }
      this.deps.assertAccepting();
    } catch (error) {
      // Canonical lookup proved absence while this Session's intake was locked.
      // No queue mutation was issued, so this reply can safely reject acceptance.
      throw new SessionTurnQueuePreflightRejectedError(error instanceof Error ? error.message : "Turn preflight failed.", { cause: error });
    }
    return this.deps.service.enqueue(owner, {
      request,
      attachments: preview.attachments,
      provider: session.provider,
      workspacePath: session.workspacePath,
    });
  }

  async getSessionTurnQueueReceipt(sessionId: string, requestId: string) {
    const normalizedId = normalizeSessionTurnClientRequestId(requestId);
    if (!normalizedId) throw new Error("The request identity is invalid.");
    const receipt = await this.deps.store.getReceipt(this.owner(await this.readSession(sessionId)), normalizedId);
    this.deps.assertActive();
    if (receipt) this.deps.service.reconcileKnownReceipt(receipt);
    return receipt;
  }

  async listSessionTurnQueue(sessionId: string) {
    return this.deps.store.listActive(this.owner(await this.readSession(sessionId)));
  }

  async listSessionTurnQueueReceipts(sessionId: string, options?: { cursor?: number; limit?: number }) {
    return this.deps.store.listReceipts(this.owner(await this.readSession(sessionId)), options);
  }

  async cancelQueuedSessionTurn(sessionId: string, id: string) {
    this.deps.assertAccepting();
    return this.deps.service.cancelQueued(this.owner(await this.readSession(sessionId)), this.requireId(id));
  }

  async releaseInterruptedSessionTurn(sessionId: string, id: string) {
    this.deps.assertAccepting();
    return this.deps.service.releaseInterrupted(this.owner(await this.readSession(sessionId)), this.requireId(id));
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
