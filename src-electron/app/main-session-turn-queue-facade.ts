import { isDeepStrictEqual } from "node:util";
import {
  sessionReplySchema,
  type SessionReply,
} from "../../src-shared/session/session-reply.js";
import { mainSessionTargetSchema } from "../../src-shared/session/session-target.js";
import {
  normalizeSessionTurnClientRequestId,
  normalizeSessionTurnSubmitSource,
  type ComposerPreview,
  type RunSessionTurnRequest,
} from "../../src-shared/session/runtime-state.js";
import {
  captureSessionExecutionOptions,
  validateSessionExecutionOptions,
  type SessionExecutionOptions,
  type SessionMessageExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import type { SessionOperationRequest } from "../../src-shared/session/session-management-contract.js";
import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import type {
  QueuedSessionTurnEditRequest,
  UpdateQueuedSessionTurnRequest,
  ReorderQueuedSessionTurnsRequest,
  RetryFailedSessionTurnRequest,
  SessionTurnQueueOwner,
  SessionTurnQueueStore,
  SessionTurnQueueOrigin,
  SessionTurnQueueCapturedInput,
  SessionTurnQueueReceipt,
} from "../../src-shared/session/session-turn-queue.js";
import type { SessionExecutionReadResult } from "../../src-shared/session/session-execution-window-contract.js";
import type { SessionTurnQueueService } from "../session/session-turn-queue-service.js";

/** 現行ストア、受付前検証、キューの永続化と表示を組み立てる依存。 */
export type MainSessionTurnQueueFacadeDeps = {
  /** キューを所有する保存世代が有効であることを確認する。 */
  assertActive(): void;
  /** 新しい受付や更新を行えることを確認する。 */
  assertAccepting(): void;
  /** 対象 ID の Session を取得し、存在しなければ null を返す。 */
  getSession(sessionId: string): Promise<Session | null>;
  /** Coordination の宛先を種類と世代まで指定して取得する。 */
  getSessionForCoordination?(
    target: SessionTurnQueueOwner & { kind: "main" | "auxiliary" },
  ): Promise<Session | null>;
  /** 受付時のモデル有効状態を検査するため、現在のアプリ設定を取得する。 */
  getAppSettings(): Promise<AppSettings>;
  /** Session のワークスペースを利用できなければ拒否する。 */
  validateWorkspace(session: Session): Promise<void>;
  /** 返信先が保存済みで参照可能であることを確認する。 */
  assertSavedReplyTo?(reference: SessionReply): Promise<void>;
  /** Session の Provider を検証し、実行設定の候補となるカタログを返す。 */
  validateProvider(
    session: Session,
  ): Promise<{ provider: ModelCatalogProvider }>;
  /** 送信本文の添付参照を Session のルートから解決する。 */
  preview(session: Session, userMessage: string): Promise<ComposerPreview>;
  /** 再試行元の Turn と確定入力の保存状態を確認する。 */
  readRetryExecution?(
    input: RetryFailedSessionTurnRequest,
  ): Promise<SessionExecutionReadResult<"get_execution">>;
  /** 再試行元の添付を現在の Session でも参照できることを確認する。 */
  validateRetryAttachments?(
    session: Session,
    attachments: SessionTurnQueueCapturedInput["attachments"],
  ): Promise<void>;
  store: SessionTurnQueueStore;
  service: SessionTurnQueueService;
  /** 実行枠がまだ解放されていない送信元 Turn の ID を返す。 */
  getUnreleasedSourceTurnIds?(): readonly string[];
  /** 送信元にすでに表示されている本文を取り出す。 */
  captureSourceDisplayText?(origin: SessionTurnQueueOrigin): string | undefined;
  /** 本文を挿入した受付結果と、その時点の送信元の表示本文を記録する。 */
  rememberSourceDisplay?(receipt: SessionTurnQueueReceipt, text: string): void;
};

/** 新しい受付を保存しておらず、受付前に拒否したと判断できる場合のエラー。 */
export class SessionTurnQueuePreflightRejectedError extends Error {}

/** GUI や Session からのキュー操作を、世代照合と受付前検証を経て永続化サービスへ渡す。 */
export class MainSessionTurnQueueFacade {
  private readonly acceptanceLocks = new Map<string, Promise<void>>();

  /** 現行のキューと、Session の正本および実行条件を検証する依存を受け取る。 */
  constructor(private readonly deps: MainSessionTurnQueueFacadeDeps) {}

  /** Session 単位で受付を直列化し、送信元 Turn の解放待ちを反映した受付記録を返す。 */
  async enqueueSessionTurn(
    sessionId: string,
    input: RunSessionTurnRequest & { incarnationId: string },
    origin?: SessionTurnQueueOrigin,
    assertActorCurrent?: () => void | Promise<void>,
  ) {
    return this.withAcceptanceLock(sessionId, async () =>
      this.projectSourceRelease(
        await this.accept(sessionId, input, origin, assertActorCurrent),
      ),
    );
  }

  /** Session 間送信を受け付け、送信側の指定と受信側の設定を組み合わせて実行条件を捕捉する。 */
  async enqueueSessionMessage(
    input: SessionOperationRequest<"enqueue">,
    origin: SessionTurnQueueOrigin,
    assertActorCurrent: () => void | Promise<void>,
    replyTo?: SessionReply,
  ) {
    const requested: SessionMessageExecutionOptions = {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.reasoningEffort }),
    };
    return this.withAcceptanceLock(input.target.sessionId, async () =>
      this.projectSourceRelease(
        await this.accept(
          input.target.sessionId,
          {
            incarnationId: input.target.incarnationId,
            clientRequestId: input.requestId,
            userMessage: input.message,
            submitSource: "composer",
            ...(replyTo ? { replyTo } : {}),
          },
          {
            ...origin,
            deliveryTiming: input.deliveryTiming ?? "immediate",
            requestedExecutionOptions: requested,
          },
          assertActorCurrent,
          requested,
        ),
      ),
    );
  }

  /** 失敗が確定した Turn の確定入力と来歴を確認し、GUI からの新しい受付として保存する。 */
  async retryFailedSessionTurn(
    sessionId: string,
    input: RetryFailedSessionTurnRequest,
    assertActorCurrent?: () => void | Promise<void>,
  ) {
    return this.withAcceptanceLock(sessionId, async () => {
      await assertActorCurrent?.();
      const session = await this.readSession(sessionId);
      const owner = this.owner(session);
      const requestId = normalizeSessionTurnClientRequestId(
        input?.clientRequestId,
      );
      if (
        !requestId ||
        input?.target?.sessionId !== sessionId ||
        input.target.incarnationId !== owner.incarnationId ||
        typeof input.receiptId !== "string" ||
        !input.receiptId.trim() ||
        !/^[1-9]\d*$/.test(input.turnId)
      ) {
        throw new SessionTurnQueuePreflightRejectedError(
          "The failed Turn identity is invalid or has changed.",
        );
      }
      const previous = await this.deps.store.getReceipt(owner, requestId);
      if (previous) {
        const source = previous.accepted?.retrySource;
        if (
          !source ||
          source.receiptId !== input.receiptId ||
          source.turnId !== input.turnId ||
          previous.accepted?.origin?.kind !== "gui"
        ) {
          throw new SessionTurnQueuePreflightRejectedError(
            "This request identity was already used for a different operation.",
          );
        }
        await assertActorCurrent?.();
        this.deps.service.reconcileKnownReceipt(previous);
        return previous;
      }
      let captured: SessionTurnQueueCapturedInput;
      try {
        this.deps.assertAccepting();
        if (
          !input.executionOptions ||
          !isDeepStrictEqual(
            captureSessionExecutionOptions(session),
            input.executionOptions,
          )
        ) {
          throw new Error(
            "Execution settings changed or are still being saved. Check the current settings and try again.",
          );
        }
        if (
          !this.deps.readRetryExecution ||
          !this.deps.validateRetryAttachments
        )
          throw new Error("Failed Turn retry is unavailable.");
        const execution = await this.deps.readRetryExecution(input);
        const source = await this.deps.store.getReceiptById(
          owner,
          input.receiptId,
        );
        if (
          !execution.ok ||
          execution.turnState !== "failed" ||
          execution.receiptState !== "failed" ||
          execution.turnId !== input.turnId ||
          execution.receiptId !== input.receiptId ||
          execution.inputs.entry?.kind !== "start" ||
          execution.inputs.entry.stage !== "fixed" ||
          !source ||
          source.state !== "failed" ||
          source.turnId !== input.turnId ||
          source.inputTurnId ||
          source.userMessageSeq === null ||
          source.userMessageSeq !== execution.userMessageSeq ||
          !source.accepted ||
          !source.dispatched
        ) {
          throw new Error(
            "This Turn is not a confirmed failed start with a saved fixed input.",
          );
        }
        const fixed = source.dispatched;
        const original = source.accepted;
        const origin = fixed.origin;
        const initialOrigin = original.origin;
        const instructionOrigin = fixed.retrySource?.origin ?? origin;
        /** 処理中に変わり得る送信元 Turn の段階を比較対象から取り除く。 */
        const comparableOrigin = (
          value: SessionTurnQueueOrigin | undefined,
        ) => {
          if (!value) return null;
          const { sourceTurnPhase: _phase, ...rest } = value;
          return rest;
        };
        if (
          !origin ||
          !initialOrigin ||
          !instructionOrigin ||
          !isDeepStrictEqual(
            comparableOrigin(origin),
            comparableOrigin(initialOrigin),
          ) ||
          !isDeepStrictEqual(fixed.retrySource, original.retrySource) ||
          origin.operation !== "send" ||
          !["gui", "session"].includes(origin.kind) ||
          origin.targetSessionId !== sessionId ||
          origin.targetIncarnationId !== owner.incarnationId ||
          instructionOrigin.operation !== "send" ||
          !["gui", "session"].includes(instructionOrigin.kind) ||
          instructionOrigin.targetSessionId !== sessionId ||
          instructionOrigin.targetIncarnationId !== owner.incarnationId ||
          (instructionOrigin.kind === "session" &&
            (!instructionOrigin.actorSessionId?.trim() ||
              !instructionOrigin.actorIncarnationId?.trim() ||
              !instructionOrigin.actorTurnId?.trim() ||
              !["main", "auxiliary"].includes(
                instructionOrigin.actorKind ?? "",
              ) ||
              !instructionOrigin.actorSnapshot?.character?.id?.trim() ||
              !instructionOrigin.actorSnapshot.character.name?.trim())) ||
          typeof fixed.request?.userMessage !== "string" ||
          !fixed.request.userMessage.trim() ||
          !Array.isArray(fixed.attachments)
        ) {
          throw new Error(
            "The original fixed input or its sender is unavailable or inconsistent.",
          );
        }
        await this.deps.validateRetryAttachments(session, fixed.attachments);
        const replyTo = fixed.request.replyTo;
        if (replyTo) await this.deps.assertSavedReplyTo?.(replyTo);
        const request: SessionTurnQueueCapturedInput["request"] = {
          clientRequestId: requestId,
          userMessage: fixed.request.userMessage,
          submitSource: "retry",
          ...(replyTo ? { replyTo } : {}),
          executionOptions: captureSessionExecutionOptions(
            input.executionOptions,
          ),
        };
        const prepared = await this.prepareExecution(
          session,
          request,
          () => this.readSession(sessionId),
          false,
        );
        const current = await this.readSession(sessionId);
        if (
          !isDeepStrictEqual(
            captureSessionExecutionOptions(current),
            request.executionOptions,
          )
        )
          throw new Error(
            "Execution settings changed while preparing the retry.",
          );
        const changedSinceAcceptance = !isDeepStrictEqual(
          {
            text: original.request.userMessage,
            attachments: original.attachments,
          },
          { text: fixed.request.userMessage, attachments: fixed.attachments },
        );
        // 同じ入力での再試行では指示の出所を維持し、変更して再試行した確定入力は GUI での編集として扱う。
        const fixedInputOrigin = changedSinceAcceptance
          ? origin
          : instructionOrigin;
        captured = {
          ...prepared,
          attachments: structuredClone(fixed.attachments),
          origin: {
            kind: "gui",
            operation: "send",
            targetSessionId: sessionId,
            targetIncarnationId: owner.incarnationId,
          },
          retrySource: {
            receiptId: source.id,
            turnId: input.turnId,
            origin: structuredClone(fixedInputOrigin),
            changedSinceAcceptance,
          },
        };
        await assertActorCurrent?.();
      } catch (error) {
        throw new SessionTurnQueuePreflightRejectedError(
          error instanceof Error
            ? error.message
            : "Failed Turn retry could not be prepared.",
          { cause: error },
        );
      }
      return this.deps.service.enqueue(owner, captured, assertActorCurrent);
    });
  }

  /** 送信元の解放を待つ受付には、保存記録を変えずに表示用の待機状態を付ける。 */
  private projectSourceRelease<T extends SessionTurnQueueReceipt | null>(
    receipt: T,
  ): T {
    const origin = receipt?.accepted?.origin;
    return receipt &&
      receipt.state === "queued" &&
      origin?.deliveryTiming === "after_source_turn" &&
      this.deps.getUnreleasedSourceTurnIds?.().includes(origin.actorTurnId!)
      ? { ...receipt, sourceTurnPendingRelease: true }
      : receipt;
  }

  /** 対象世代と送信元を検証し、一致する再送には既存記録を返し、新規要求だけを事前確認して保存する。 */
  private async accept(
    sessionId: string,
    input: Omit<RunSessionTurnRequest, "executionOptions"> & {
      incarnationId: string;
      executionOptions?: SessionExecutionOptions;
    },
    origin?: SessionTurnQueueOrigin,
    assertActorCurrent?: () => void | Promise<void>,
    requested?: SessionMessageExecutionOptions,
  ) {
    await assertActorCurrent?.();
    const session = await this.readSession(sessionId);
    const owner = this.owner(session);
    let acceptedOrigin: SessionTurnQueueOrigin = origin
      ? structuredClone(origin)
      : {
          kind: "gui",
          operation: "send",
          targetSessionId: owner.sessionId,
          targetIncarnationId: owner.incarnationId,
        };
    if (
      acceptedOrigin.targetSessionId !== owner.sessionId ||
      acceptedOrigin.targetIncarnationId !== owner.incarnationId ||
      acceptedOrigin.operation !== "send" ||
      !["gui", "session"].includes(acceptedOrigin.kind) ||
      (acceptedOrigin.kind === "session" &&
        (!acceptedOrigin.actorSessionId?.trim() ||
          !acceptedOrigin.actorIncarnationId?.trim() ||
          !acceptedOrigin.actorTurnId?.trim()))
    ) {
      throw new Error(
        "The queue origin does not identify the actual actor and target.",
      );
    }
    if (!input || input.incarnationId !== owner.incarnationId)
      throw new Error(
        "The Session identity changed. Reopen it before sending.",
      );
    const requestId = normalizeSessionTurnClientRequestId(
      input.clientRequestId,
    );
    const source = normalizeSessionTurnSubmitSource(input.submitSource);
    if (
      !requestId ||
      !source ||
      typeof input.userMessage !== "string" ||
      !input.userMessage.trim()
    ) {
      throw new Error(
        "A message, request identity, and submit source are required.",
      );
    }
    const previous = await this.deps.store.getReceipt(owner, requestId);
    this.deps.assertActive();
    let executionOptions = input.executionOptions;
    if (requested) {
      if (previous) {
        const saved = previous.accepted?.origin;
        if (
          !saved ||
          saved.kind !== "session" ||
          saved.actorKind !== acceptedOrigin.actorKind ||
          saved.actorSessionId !== acceptedOrigin.actorSessionId ||
          saved.actorIncarnationId !== acceptedOrigin.actorIncarnationId ||
          (saved.deliveryTiming ?? "immediate") !==
            acceptedOrigin.deliveryTiming ||
          !isDeepStrictEqual(saved.requestedExecutionOptions, requested)
        ) {
          throw new SessionTurnQueuePreflightRejectedError(
            "This request identity was already used with different input or actor; query its receipt for the original acceptance.",
          );
        }
        acceptedOrigin = saved;
        executionOptions = previous.accepted!.request.executionOptions;
      } else {
        executionOptions = {
          ...captureSessionExecutionOptions(session),
          ...requested,
        };
      }
    }
    if (!executionOptions || typeof executionOptions !== "object")
      throw new Error("Turn execution options are required.");
    const replyTo =
      origin && previous ? previous.accepted?.request.replyTo : input.replyTo;
    const request: RunSessionTurnRequest & { clientRequestId: string } = {
      userMessage: input.userMessage.trim(),
      ...(replyTo === undefined
        ? {}
        : { replyTo: sessionReplySchema.parse(replyTo) }),
      ...(!origin &&
      session.sessionKind === "default" &&
      source === "composer" &&
      input.mainConversationFrame !== undefined
        ? {
            mainConversationFrame: mainSessionTargetSchema
              .nullable()
              .parse(input.mainConversationFrame),
          }
        : {}),
      clientRequestId: requestId,
      submitSource: source,
      executionOptions: captureSessionExecutionOptions(executionOptions),
      ...(input.auxiliaryDraftIncarnation === undefined
        ? {}
        : { auxiliaryDraftIncarnation: input.auxiliaryDraftIncarnation }),
      ...(input.auxiliaryDraftDurableRevision === undefined
        ? {}
        : {
            auxiliaryDraftDurableRevision: input.auxiliaryDraftDurableRevision,
          }),
      ...(input.displayAnchorParentMessageCount === undefined
        ? {}
        : {
            displayAnchorParentMessageCount:
              input.displayAnchorParentMessageCount,
          }),
    };
    if (previous) {
      if (!previous.accepted)
        throw new Error(
          "The original queue acceptance input is unavailable; query its receipt instead.",
        );
      if (
        !isDeepStrictEqual(previous.accepted.request, request) ||
        !isDeepStrictEqual(previous.accepted.origin, acceptedOrigin)
      )
        throw new SessionTurnQueuePreflightRejectedError(
          "This request identity was already used with different input or actor.",
        );
      await assertActorCurrent?.();
      this.deps.service.reconcileKnownReceipt(previous);
      return previous;
    }
    let prepared: SessionTurnQueueCapturedInput;
    try {
      this.deps.assertAccepting();
      await assertActorCurrent?.();
      if (request.replyTo)
        await this.deps.assertSavedReplyTo?.(request.replyTo);
      if (request.mainConversationFrame) {
        const peer = await this.deps.getSession(
          request.mainConversationFrame.sessionId,
        );
        if (
          !peer ||
          peer.sessionKind !== "default" ||
          getSessionIncarnationId(peer) !==
            request.mainConversationFrame.incarnationId ||
          peer.parentSessionId !== owner.sessionId ||
          peer.createdBySessionId !== owner.sessionId ||
          peer.rootSessionId !==
            (session.rootSessionId?.trim() || owner.sessionId) ||
          (peer.sessionRole !== "executor" &&
            peer.sessionRole !== "task-coordinator")
        ) {
          throw new Error(
            "The Main conversation thread is no longer available.",
          );
        }
      }
      if (
        request.auxiliaryDraftIncarnation !== undefined &&
        (typeof request.auxiliaryDraftIncarnation !== "string" ||
          !request.auxiliaryDraftIncarnation.trim())
      )
        throw new Error("The Auxiliary draft identity is invalid.");
      if (
        request.auxiliaryDraftDurableRevision !== undefined &&
        (!Number.isSafeInteger(request.auxiliaryDraftDurableRevision) ||
          request.auxiliaryDraftDurableRevision < 0)
      )
        throw new Error("The Auxiliary draft revision is invalid.");
      if (
        request.displayAnchorParentMessageCount !== undefined &&
        (!Number.isSafeInteger(request.displayAnchorParentMessageCount) ||
          request.displayAnchorParentMessageCount < 0)
      )
        throw new Error("The Auxiliary display anchor is invalid.");
      prepared = await this.prepareExecution(
        session,
        request,
        () => this.readSession(sessionId),
        true,
        requested !== undefined,
      );
      await assertActorCurrent?.();
    } catch (error) {
      // この Session の受付をロックした状態で、正本を照会して対象が存在しないことを確認済み。
      // キューへの変更を発行していないので、この応答では受理を拒否したと確定できる。
      throw new SessionTurnQueuePreflightRejectedError(
        error instanceof Error ? error.message : "Turn preflight failed.",
        { cause: error },
      );
    }
    const sourceDisplayText =
      acceptedOrigin.kind === "session"
        ? this.deps.captureSourceDisplayText?.(acceptedOrigin)
        : undefined;
    const receipt = await this.deps.service.enqueue(
      owner,
      {
        ...prepared,
        origin: acceptedOrigin,
        ...(sourceDisplayText === undefined
          ? {}
          : { sourceDisplayPosition: sourceDisplayText.length }),
      },
      assertActorCurrent,
    );
    if (receipt.sourceDisplayInserted && sourceDisplayText !== undefined)
      this.deps.rememberSourceDisplay?.(receipt, sourceDisplayText);
    if (receipt.sourceDisplayInserted === undefined) return receipt;
    const { sourceDisplayInserted: _inserted, ...result } = receipt;
    return result;
  }

  /** Coordination の指定宛先について実行条件だけを捕捉し、キューへの保存は行わない。 */
  async prepareCoordinationDelivery(
    target: SessionTurnQueueOwner & { kind: "main" | "auxiliary" },
    operationId: string,
  ): Promise<SessionTurnQueueCapturedInput> {
    this.deps.assertAccepting();
    const requestId = normalizeSessionTurnClientRequestId(operationId);
    if (!requestId || !this.deps.getSessionForCoordination)
      throw new Error(
        "Coordination delivery preparation is unavailable or invalid.",
      );
    /** Coordination の宛先を読み直し、種類を指定した取得結果の ID・世代・編集可否を確認する。 */
    const read = async () => {
      const session = await this.deps.getSessionForCoordination!(target);
      this.deps.assertActive();
      if (
        !session ||
        session.id !== target.sessionId ||
        getSessionIncarnationId(session) !== target.incarnationId ||
        session.accessMode !== "active"
      )
        throw new Error(
          "The Coordination delivery target changed or is unavailable.",
        );
      return session;
    };
    const session = await read();
    return this.prepareExecution(
      session,
      {
        clientRequestId: requestId,
        userMessage: "",
        submitSource: "retry",
        executionOptions: captureSessionExecutionOptions(session),
      },
      read,
      false,
    );
  }

  /** ワークスペース、Provider、実行設定、必要な添付を検証し、再照合した実行先とともに捕捉する。 */
  private async prepareExecution(
    session: Session,
    request: SessionTurnQueueCapturedInput["request"],
    readCurrent: () => Promise<Session>,
    resolveAttachments: boolean,
    validateMessageSelection = false,
  ): Promise<SessionTurnQueueCapturedInput> {
    this.deps.assertAccepting();
    await this.deps.validateWorkspace(session);
    const catalog = await this.deps.validateProvider(session);
    const executionOptions = validateSessionExecutionOptions(
      request.executionOptions,
      catalog.provider,
    );
    if (validateMessageSelection) {
      const model = catalog.provider.models.find(
        (entry) => entry.id === executionOptions.model,
      );
      if (!model)
        throw new Error(
          "The selected message model is not in the recipient's discovered model list.",
        );
      if (
        executionOptions.reasoningEffort !== "" &&
        !model.reasoningEfforts.includes(executionOptions.reasoningEffort)
      ) {
        throw new Error(
          "The selected message depth is not supported by this model.",
        );
      }
    }
    const preview = resolveAttachments
      ? await this.deps.preview(session, request.userMessage)
      : { attachments: [], errors: [] };
    if (preview.errors.length) throw new Error(preview.errors[0]);
    assertModelEnabled(
      (await this.deps.getAppSettings()).modelAvailability,
      session.provider,
      executionOptions.model,
    );
    const current = await readCurrent();
    if (
      getSessionIncarnationId(current) !== getSessionIncarnationId(session) ||
      current.provider !== session.provider ||
      current.workspacePath !== session.workspacePath
    )
      throw new Error("The Session identity changed during queue acceptance.");
    this.deps.assertAccepting();
    return {
      request: { ...request, executionOptions },
      attachments: preview.attachments,
      provider: session.provider,
      workspacePath: session.workspacePath,
    };
  }

  /** クライアント要求 ID から受付記録を引き、既知の結果を実行サービスと照合する。 */
  async getSessionTurnQueueReceipt(
    sessionId: string,
    requestId: string,
    incarnationId?: string,
  ) {
    const normalizedId = normalizeSessionTurnClientRequestId(requestId);
    if (!normalizedId) throw new Error("The request identity is invalid.");
    const owner = this.owner(await this.readSession(sessionId));
    if (incarnationId !== undefined && incarnationId !== owner.incarnationId)
      throw new Error("The Session identity changed.");
    const receipt = await this.deps.store.getReceipt(owner, normalizedId);
    this.deps.assertActive();
    if (receipt) this.deps.service.reconcileKnownReceipt(receipt);
    return this.projectSourceRelease(receipt);
  }

  /** 現在の世代について有効なキュー項目を並べ、送信元の解放待ちを表示に反映する。 */
  async listSessionTurnQueue(sessionId: string) {
    const receipts = await this.deps.store.listActive(
      this.owner(await this.readSession(sessionId)),
    );
    return receipts.map((receipt) => this.projectSourceRelease(receipt));
  }

  /** 現在の世代の受付履歴を指定されたページで読み、送信元の解放待ちを表示に反映する。 */
  async listSessionTurnQueueReceipts(
    sessionId: string,
    options?: { cursor?: number; limit?: number },
  ) {
    const page = await this.deps.store.listReceipts(
      this.owner(await this.readSession(sessionId)),
      options,
    );
    return {
      ...page,
      receipts: page.receipts.map((receipt) =>
        this.projectSourceRelease(receipt),
      ),
    };
  }

  /** 現行 Session の指定項目について、キュー待ちの状態から取り消すよう要求する。 */
  async cancelQueuedSessionTurn(sessionId: string, id: string) {
    this.deps.assertAccepting();
    return this.deps.service.cancelQueued(
      this.owner(await this.readSession(sessionId)),
      this.requireId(id),
    );
  }

  /** 指定世代の Session で受付 ID を照会し、既知の結果を実行サービスと照合する。 */
  async getSessionTurnReceipt(owner: SessionTurnQueueOwner, id: string) {
    await this.readEditSession(owner);
    const receipt = await this.deps.store.getReceiptById(
      owner,
      this.requireId(id),
    );
    this.deps.assertActive();
    if (receipt) this.deps.service.reconcileKnownReceipt(receipt);
    return receipt;
  }

  /** 指定世代の受付の取り消しを試み、返された状態が取り消し済みかを結果に変換する。 */
  async cancelSessionTurnReceipt(
    owner: SessionTurnQueueOwner,
    id: string,
    assertAuthorized?: () => void | Promise<void>,
  ) {
    this.deps.assertAccepting();
    await this.readEditSession(owner);
    const receipt = await this.deps.service.cancelQueued(
      owner,
      this.requireId(id),
      assertAuthorized,
    );
    return {
      outcome:
        receipt.state === "canceled"
          ? ("applied" as const)
          : ("not-applied" as const),
      receipt,
    };
  }

  /** 指定世代の待機中項目について、編集を始められるようにする。 */
  beginQueuedSessionTurnEdit(
    sessionId: string,
    input: QueuedSessionTurnEditRequest,
  ) {
    this.deps.assertAccepting();
    const owner = this.editOwner(sessionId, input);
    return this.deps.service.beginQueuedEdit(owner, input.id, async () => {
      await this.readEditSession(owner);
    });
  }

  /** 待機中の本文と添付を差し替え、捕捉済みの実行先が途中で変わった場合は拒否する。 */
  updateQueuedSessionTurn(
    sessionId: string,
    input: UpdateQueuedSessionTurnRequest,
  ) {
    this.deps.assertAccepting();
    const owner = this.editOwner(sessionId, input);
    return this.deps.service.updateQueued(owner, input.id, async (receipt) => {
      if (typeof input.userMessage !== "string" || !input.userMessage.trim())
        throw new Error("A queued message is required.");
      const session = await this.readEditSession(owner);
      if (
        session.provider !== receipt.captured.provider ||
        session.workspacePath !== receipt.captured.workspacePath
      )
        throw new Error("The queued Session execution context changed.");
      await this.deps.validateWorkspace(session);
      await this.deps.validateProvider(session);
      const userMessage = input.userMessage.trim();
      const preview = await this.deps.preview(session, userMessage);
      if (preview.errors.length) throw new Error(preview.errors[0]);
      const current = await this.readEditSession(owner);
      if (
        current.provider !== session.provider ||
        current.workspacePath !== session.workspacePath
      )
        throw new Error(
          "The Session execution context changed during editing.",
        );
      this.deps.assertAccepting();
      return { userMessage, attachments: preview.attachments };
    });
  }

  /** 指定した世代と受付 ID を照合し、キュー項目の編集状態を解除する。 */
  async cancelQueuedSessionTurnEdit(
    sessionId: string,
    input: QueuedSessionTurnEditRequest,
  ): Promise<void> {
    const owner = this.editOwner(sessionId, input);
    await this.readEditSession(owner);
    await this.deps.service.cancelQueuedEdit(owner, input.id);
  }

  /** 編集要求に含まれる世代と受付 ID を検証し、所有者の照合に使う。 */
  private editOwner(
    sessionId: string,
    input: QueuedSessionTurnEditRequest,
  ): SessionTurnQueueOwner {
    if (
      typeof sessionId !== "string" ||
      !sessionId.trim() ||
      !input ||
      typeof input.incarnationId !== "string" ||
      !input.incarnationId.trim()
    )
      throw new Error("A Session identity is required.");
    this.requireId(input.id);
    return { sessionId, incarnationId: input.incarnationId };
  }

  /** 編集や参照の対象を読み、指定された世代の Session が有効か確認する。 */
  private async readEditSession(
    owner: SessionTurnQueueOwner,
  ): Promise<Session> {
    const session = await this.readSession(owner.sessionId);
    if (getSessionIncarnationId(session) !== owner.incarnationId)
      throw new Error(
        "The Session identity changed. Reopen it before editing.",
      );
    return session;
  }

  /** 指定世代と期待する並びを照合して、捕捉済み入力の内容は変えずに順番を更新する。 */
  async reorderQueuedSessionTurns(
    sessionId: string,
    input: ReorderQueuedSessionTurnsRequest,
  ) {
    this.deps.assertAccepting();
    const owner = this.owner(await this.readSession(sessionId));
    if (!input || input.incarnationId !== owner.incarnationId)
      throw new Error(
        "The Session identity changed. Reopen it before reordering.",
      );
    const result = await this.deps.service.reorderQueued(
      owner,
      input.expectedQueuedIds,
      input.queuedIds,
    );
    this.deps.assertActive();
    return {
      ...result,
      receipts: result.receipts.map((receipt) =>
        this.projectSourceRelease(receipt),
      ),
    };
  }

  /** 指定の実行中 Turn を対象に、待機項目を追加入力として送るよう要求する。 */
  async sendQueuedSessionInput(
    sessionId: string,
    id: string,
    expectedTurnId: string,
  ) {
    this.deps.assertAccepting();
    const owner = this.owner(await this.readSession(sessionId));
    if (typeof expectedTurnId !== "string" || !expectedTurnId.trim())
      throw new Error("A current Turn identity is required.");
    this.deps.assertAccepting();
    return this.deps.service.sendQueuedInput(
      owner,
      this.requireId(id),
      expectedTurnId,
    );
  }

  /** 保存世代を前後で照合し、現在操作できる Session だけを返す。 */
  private async readSession(sessionId: string): Promise<Session> {
    this.deps.assertActive();
    if (typeof sessionId !== "string" || !sessionId.trim())
      throw new Error("A Session identity is required.");
    const session = await this.deps.getSession(sessionId);
    this.deps.assertActive();
    if (!session || session.accessMode !== "active")
      throw new Error("The Session is unavailable or read-only.");
    return session;
  }

  /** キュー所有者を Session ID と現在の世代 ID の組で識別する。 */
  private owner(session: Session): SessionTurnQueueOwner {
    return {
      sessionId: session.id,
      incarnationId: getSessionIncarnationId(session),
    };
  }

  /** 空のキュー項目 ID を拒否し、有効なら入力をそのまま返す。 */
  private requireId(id: string): string {
    if (typeof id !== "string" || !id.trim())
      throw new Error("A queue item identity is required.");
    return id;
  }

  /** 同一 Session の受付を直列化し、失敗しても次の受付へ進めるようロックを解放する。 */
  private withAcceptanceLock<T>(
    sessionId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.acceptanceLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run);
    const released = next.then(
      () => undefined,
      () => undefined,
    );
    this.acceptanceLocks.set(sessionId, released);
    void released.then(() => {
      if (this.acceptanceLocks.get(sessionId) === released)
        this.acceptanceLocks.delete(sessionId);
    });
    return next;
  }
}
