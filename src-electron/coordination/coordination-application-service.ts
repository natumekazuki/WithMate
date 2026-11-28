import {
  coordinationRequestSchema,
  type CoordinationActor,
  type CoordinationIdentity,
  type CoordinationRecord,
  type CoordinationRequest,
  type CoordinationResult,
  type CoordinationStore,
} from "../../src-shared/coordination/coordination-contract.js";
import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueReceipt,
} from "../../src-shared/session/session-turn-queue.js";
import {
  assertRuntimeTurnAdmission,
  runWithoutRuntimeTurnAdmission,
} from "../platform/agent-runtime/runtime-turn-admission.js";
import {
  CoordinationRejectedError,
  isCoordinationDeletedError,
} from "./coordination-errors.js";

/** 相談の永続化、受信側への配送準備と、確定後の通知に使う依存関係。 */
export type CoordinationApplicationDeps = {
  /** 現在のストアを取得し、非同期の配送準備中に世代が変わっていないか照合できるようにする。 */
  getStore(): CoordinationStore;
  /** 保存先が定めた受信者に対し、操作 ID と実行主体を使ってキュー入力を準備する。 */
  prepareDelivery(
    target: CoordinationIdentity,
    operationId: string,
    actor: CoordinationActor,
  ): Promise<SessionTurnQueueCapturedInput>;
  /** 確定済みのキュー受領記録を通知し、必要な場合は送信側の表示文も渡す。 */
  onAccepted?(
    receipt: SessionTurnQueueReceipt,
    sourceDisplayText?: string,
  ): void;
  /** 操作を確定した後に生じた通知の失敗を記録する。 */
  onNotificationError?(error: unknown): void;
};
/** 相談の要求を検証し、永続化と配送の確定後にキュー・購読側へ通知する。 */
export class CoordinationApplicationService {
  private readonly listeners = new Set<(record: CoordinationRecord) => void>();
  /** 保存先の取得と配送・通知の処理を具体的な実行環境から受け取る。 */
  constructor(private readonly deps: CoordinationApplicationDeps) {}
  /** 保存結果の通知先を登録し、同じ購読を解除する関数を返す。 */
  subscribe(listener: (record: CoordinationRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** 現在の Turn を含む Agent の識別情報で、共通の相談操作を実行する。 */
  executeAgent(
    actor: CoordinationIdentity & { turnId: string },
    request: CoordinationRequest,
    guard: () => boolean = () => true,
  ) {
    return this.execute(actor, request, guard);
  }
  /** 呼び出し側のガードを適用し、Session を代理せずユーザー自身の操作として実行する。 */
  executeUser(request: CoordinationRequest, guard: () => boolean) {
    return this.execute({ kind: "user" }, request, guard);
  }
  /** 指定された Session の視点で相談を一覧・取得する。他の操作はこの入口では拒否する。 */
  read(
    actor: CoordinationIdentity,
    request: CoordinationRequest,
    guard: () => boolean = () => true,
  ) {
    if (request.operation !== "list" && request.operation !== "get")
      throw new Error("Coordination read cannot mutate state.");
    return this.execute({ ...actor, turnId: "" }, request, guard);
  }
  /** 要求を検証し、配送準備の前後で権限とストアを照合した後、操作を確定して結果を通知する。 */
  private async execute(
    actor: CoordinationActor,
    value: CoordinationRequest,
    guard: () => boolean,
  ): Promise<CoordinationResult> {
    const request = coordinationRequestSchema.parse(value);
    const store = this.deps.getStore();
    /** 実行中の Turn、呼び出し元の認可、捕捉したストアのいずれかが失効したら処理を止める。 */
    const check = () => {
      assertRuntimeTurnAdmission();
      if (!guard() || store !== this.deps.getStore())
        throw new Error("Coordination authority changed.");
    };
    check();
    let target: CoordinationIdentity | null;
    let captured: SessionTurnQueueCapturedInput | null;
    try {
      target = await store.deliveryTarget({ actor, request });
      captured =
        target && "operationId" in request
          ? await this.deps.prepareDelivery(target, request.operationId, actor)
          : null;
    } catch (error) {
      if (isCoordinationDeletedError(error)) throw error;
      throw new CoordinationRejectedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    check();
    const stored = await store.execute({
      actor,
      request,
      ...(target && captured ? { delivery: { target, captured } } : {}),
    });
    const { queueUpdates = [], ...result } = stored;
    // ウィンドウに通知できなくても、操作の保存は取り消されない。
    for (const receipt of queueUpdates) {
      try {
        runWithoutRuntimeTurnAdmission(() => this.deps.onAccepted?.(receipt));
      } catch (error) {
        this.deps.onNotificationError?.(error);
      }
    }
    if ("receipt" in result && result.receipt) {
      const receipt = result.receipt;
      try {
        runWithoutRuntimeTurnAdmission(() =>
          this.deps.onAccepted?.(receipt, captured?.sourceDisplayText),
        );
      } catch (error) {
        this.deps.onNotificationError?.(error);
      } finally {
        delete receipt.sourceDisplayInserted;
      }
    }
    if (
      "record" in result &&
      (request.operation !== "get" ||
        (actor.kind !== "user" &&
          actor.kind === result.record.initiator.kind &&
          actor.sessionId === result.record.initiator.sessionId &&
          actor.incarnationId === result.record.initiator.incarnationId &&
          result.record.answers.length > 0))
    )
      for (const listener of this.listeners) {
        try {
          listener(result.record);
        } catch (error) {
          this.deps.onNotificationError?.(error);
        }
      }
    return result;
  }
}
