import { projectCharacterPublicProfile } from "../../src-shared/character/character-participant.js";
import {
  sessionOperationRequestSchemas,
  type SessionOperation,
  type SessionOperationRequest,
  type SessionOperationResult,
  type SessionTarget,
} from "../../src-shared/session/session-management-contract.js";
import {
  assertDirectChildSessionControl,
  assertDirectSessionSend,
  matchesRelatedSession,
  type RelatedSession,
  type SessionManagementScope,
  type SessionManagementSelection,
} from "./session-relationship-resolver.js";
import type {
  ExecutionReadOperation,
  ExecutionReadRequest,
} from "../../src-shared/session/session-execution-read.js";
import {
  coordinationRequestSchema,
  type CoordinationRequest,
  type CoordinationResult,
} from "../../src-shared/coordination/coordination-contract.js";
import {
  assertChildSessionRole,
  normalizeSessionRelationship,
} from "../../src-shared/session/session-role.js";
import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import {
  captureSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import { getSandboxOptionsForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import { getSessionApprovalChoices } from "../../src-shared/settings/session-approval-choice.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { SessionSteerResult } from "../../src-shared/session/session-turn-queue.js";
import {
  isSessionOperatingPolicyOperation,
  type SessionOperatingPolicyOperation,
} from "../../src-shared/session/session-operating-policy.js";
import { validateSessionInstructions } from "../../src-shared/session/session-instructions.js";
import type { LocalPrAgentOperation } from "../../src-shared/local-pr/local-pr-contract.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** 現在の WithMate Turn の ID と、それに対応する受付・保存された起点。該当情報がなければ null。 */
export type SessionCurrentTurn = {
  turnId: string | null;
  receipt: unknown | null;
  origin: unknown | null;
};
/** 保存済みの実行主体と承認条件を、公開アダプターから Session 操作に引き継ぐ。 */
export type SessionManagementContext = {
  actor: SessionTarget;
  /** バインディングと同じ Turn が引き続き有効かを確認し、失効していれば操作を止める。 */
  assertCurrent(): void;
  actorExecution?: {
    providerId: string;
    executionOptions: SessionExecutionOptions;
  };
};
/** Session 操作が利用する、保存関係・実行状態・履歴・永続化の境界。 */
export type SessionManagementApplicationDeps = {
  /** 実行主体の作業場所を基準に、選定方針・利用枠・Worktree の照会や設定を扱う。 */
  operatingPolicy(
    actor: RelatedSession,
    operation: SessionOperatingPolicyOperation,
    request: unknown,
    assertCurrent: () => void,
  ): Promise<SessionOperationResult>;
  /** 保存済みの実行主体と選択された対象またはページを同じ読み取りで取得する。 */
  readSessionScope(
    actor: SessionTarget,
    selection: SessionManagementSelection,
  ): Promise<SessionManagementScope>;
  /** 指定の実行主体に対応する現在の Turn と、利用できる受付・起点を読み出す。 */
  currentTurn(actor: RelatedSession): Promise<SessionCurrentTurn>;
  /** バインディングに対応する実行主体の本文だけを読み取る。Auxiliary から Main へのフォールバックはしない。 */
  getInstructions(target: SessionTarget): Awaitable<string>;
  /** バインディングに対応する実行主体の本文だけを置き換える。不正な入力は書き込む前に拒否する。 */
  setInstructions(
    target: SessionTarget,
    body: string,
  ): Awaitable<{ byteLength: number }>;
  /** 保存済みの Crew 所属から Crew Folder の根とパスを取得する。 */
  crewFolder(
    actor: RelatedSession,
  ): Promise<{ rootSessionId: string; path: string }>;
  /** 同じ所有世代のディレクトリを照会し、変更が要求された場合だけ追加パスを更新する。 */
  directories(
    target: RelatedSession,
    change: { operation: "add" | "remove"; directoryPath: string } | null,
    assertCurrent: () => void,
  ): Promise<{
    workspacePath: string;
    sessionFolderPath: string;
    crewFolder: { rootSessionId: string; path: string };
    additionalDirectories: string[];
  }>;
  /** 実行主体自身のメタデータを更新し、更新時の認可を再確認する。 */
  updateMetadata(
    actor: RelatedSession,
    patch: SessionOperationRequest<"update_metadata">,
    assertCurrent: () => void,
  ): Promise<unknown>;
  /** 実際の送信元とその Turn を来歴として、宛先の新しい入力をキューに受け付ける。 */
  enqueue(
    target: RelatedSession,
    input: SessionOperationRequest<"enqueue">,
    actor: RelatedSession,
    turnId: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
  /** 指定宛先と送信キーに対応する受付を読み、申告された送信元ではなく保存済みの来歴を返す。 */
  getReceipt(
    target: RelatedSession,
    requestId: string,
  ): Promise<{
    accepted?: {
      origin?: {
        kind: string;
        actorKind?: "main" | "auxiliary";
        actorSessionId?: string;
        actorIncarnationId?: string;
        targetSessionId: string;
        targetIncarnationId: string;
        operation: string;
      };
    } | null;
  } | null>;
  /** 宛先の指定された受付を取り消す。すでに開始した Turn の停止は含まない。 */
  cancelReceipt(
    target: RelatedSession,
    receiptId: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
  /** 宛先の指定された実行中 Turn に停止を要求する。最新の別 Turn には置き換えない。 */
  stopTurn(
    target: RelatedSession,
    turnId: string,
    assertCurrent: () => void,
  ): Promise<unknown>;
  /** 指定の子の実行中 Turn に、起点 Turn が有効な状態で追加指示を送る。 */
  steer(
    target: RelatedSession,
    input: SessionOperationRequest<"steer">,
    actor: RelatedSession,
    turnId: string,
    assertCurrent: () => void,
  ): Promise<SessionSteerResult>;
  /** 確認済みの対象について、指定の履歴または実行記録を読み取る。 */
  readExecution(
    target: RelatedSession,
    operation: ExecutionReadOperation,
    request: ExecutionReadRequest,
    assertCurrent: () => void,
  ): Promise<SessionOperationResult>;
  /** 実行主体の Coordination 要求を処理し、変更時には起点 Turn をひも付ける。 */
  coordinate(
    actor: RelatedSession,
    turnId: string | null,
    request: CoordinationRequest,
    assertCurrent: () => void,
  ): Promise<CoordinationResult>;
  /** 実行主体と作成条件から通常の子 Session を作る。引き継ぐ実行条件は起点 Turn のものを使用できる。 */
  createChild(
    actor: RelatedSession,
    request: SessionOperationRequest<"create_child">,
    assertCurrent: () => void,
    actorExecution: SessionManagementContext["actorExecution"],
  ): Promise<Session>;
  /** 実行主体から照会できる作業場所・提供元のモデルカタログを取得する。 */
  catalog(
    actor: RelatedSession,
    request: SessionOperationRequest<"get_catalog">,
  ): Promise<ModelCatalogSnapshot>;
};
/** 予期できる操作拒否を、公開境界で判定できるエラーコード付きで伝える。 */
export class SessionManagementError extends Error {
  /** 失敗の分類コードと、利用者に返す説明を保持する。 */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 書き込みは保存済みの関係に基づいて認可する。公開の保存済みメタデータは Crew をまたいで読み取れる。 */
export class SessionManagementApplication {
  /** 保存済みの関係と現在の実行を使う依存を受け取る。公開入力ごとの処理は execute で分ける。 */
  constructor(readonly deps: SessionManagementApplicationDeps) {}

  /** 公開入力を検証して保存済みの主体と対象を照合し、操作別の関係・現在性を確認してから担当処理へ渡す。 */
  async execute(
    operation: Exclude<SessionOperation, LocalPrAgentOperation>,
    body: unknown,
    context: SessionManagementContext,
  ): Promise<SessionOperationResult> {
    const parsed = sessionOperationRequestSchemas[operation].safeParse(body);
    if (!parsed.success)
      return {
        ok: false,
        code: "SESSION_INVALID_REQUEST",
        effect: "none",
        message: parsed.error.message,
      };
    const selection =
      operation === "list"
        ? { query: parsed.data as SessionOperationRequest<"list"> }
        : "target" in parsed.data
          ? { target: parsed.data.target }
          : null;
    const {
      actor,
      target: savedTarget,
      page,
    } = await this.deps.readSessionScope(context.actor, selection);
    context.assertCurrent();
    if (!actor || !matchesRelatedSession(actor, context.actor))
      throw new SessionManagementError(
        "SESSION_ACTOR_UNAVAILABLE",
        "The bound actor no longer exists.",
      );
    if (isSessionOperatingPolicyOperation(operation)) {
      return this.deps.operatingPolicy(
        actor,
        operation,
        parsed.data,
        context.assertCurrent,
      );
    }
    /** 保存済みの対象がない場合と、指定の世代と異なる対象に置き換わった場合を区別する。 */
    const target = (reference: SessionTarget): RelatedSession => {
      const found = savedTarget;
      if (!found)
        throw new SessionManagementError(
          "SESSION_NOT_FOUND",
          "The target Session does not exist.",
        );
      if (!matchesRelatedSession(found, reference))
        throw new SessionManagementError(
          "SESSION_REPLACED",
          "The target Session incarnation changed.",
        );
      return found;
    };
    switch (operation) {
      case "get_catalog": {
        const catalog = await this.deps.catalog(
          actor,
          parsed.data as SessionOperationRequest<"get_catalog">,
        );
        context.assertCurrent();
        return {
          ok: true,
          catalog,
          options: catalog.providers.map((provider) => ({
            provider: provider.id,
            approvalModes: getSessionApprovalChoices(),
            sandboxModes: getSandboxOptionsForProvider(provider.id),
            reviewers: [],
          })),
        };
      }
      case "create_child": {
        const request = parsed.data as SessionOperationRequest<"create_child">;
        try {
          if (actor.kind !== "main") throw new Error();
          assertChildSessionRole(actor.sessionRole, request.role);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "This actual Session Role cannot create the requested child.",
          );
        }
        context.assertCurrent();
        const created = await this.deps.createChild(
          actor,
          request,
          context.assertCurrent,
          context.actorExecution,
        );
        const relationship = normalizeSessionRelationship(created);
        const incarnationId = getSessionIncarnationId(created);
        return {
          ok: true,
          session: {
            ...relationship,
            id: created.id,
            incarnationId,
            kind: "main",
            role: relationship.sessionRole,
            mainSessionId: created.id,
            mainIncarnationId: incarnationId,
            title: created.taskTitle,
            description: created.description ?? "",
            runState: created.runState,
            provider: created.provider,
            workspacePath: created.workspacePath,
            character: projectCharacterPublicProfile(created),
          },
          character: projectCharacterPublicProfile(created),
          provider: created.provider,
          workspacePath: created.workspacePath,
          executionOptions: captureSessionExecutionOptions(created),
        };
      }
      case "coordination_list":
      case "coordination_get":
      case "coordination_create":
      case "coordination_deliver":
      case "coordination_escalate":
      case "coordination_answer":
      case "coordination_withdraw":
      case "coordination_resolve":
      case "coordination_consume":
      case "coordination_correct": {
        const request = coordinationRequestSchema.parse({
          ...parsed.data,
          operation: operation.slice("coordination_".length),
        });
        const read =
          request.operation === "list" || request.operation === "get";
        const turnId = read
          ? null
          : (await this.deps.currentTurn(actor)).turnId;
        context.assertCurrent();
        if (!read && !turnId)
          throw new SessionManagementError(
            "SESSION_TURN_UNAVAILABLE",
            "The actor has no current saved WithMate Turn.",
          );
        return {
          ok: true,
          ...(await this.deps.coordinate(
            actor,
            turnId,
            request,
            context.assertCurrent,
          )),
        };
      }
      case "list_issued_coordinations":
      case "list_sent_deliveries":
      case "list_sent_steers":
      case "list_executions":
      case "list_messages":
      case "get_message":
      case "list_operations":
      case "get_operation_detail":
      case "get_execution":
      case "list_execution_inputs":
      case "get_execution_input":
      case "list_execution_outputs":
      case "get_execution_output":
      case "list_execution_operations":
      case "get_execution_operation_detail": {
        const request = parsed.data as ExecutionReadRequest;
        const destination = target(request.target);
        context.assertCurrent();
        const result = await this.deps.readExecution(
          destination,
          operation,
          request,
          context.assertCurrent,
        );
        context.assertCurrent();
        return result;
      }
      case "self":
        return {
          ok: true,
          session: actor,
          currentTurn: await this.deps.currentTurn(actor),
          crewFolder: await this.deps.crewFolder(actor),
        };
      case "list":
        if (!page) throw new Error("The saved Session page is unavailable.");
        return { ok: true, ...page };
      case "get": {
        const destination = target(
          (parsed.data as SessionOperationRequest<"get">).target,
        );
        return {
          ok: true,
          session: destination,
          currentTurn: await this.deps.currentTurn(destination),
          crewFolder: await this.deps.crewFolder(destination),
        };
      }
      case "list_directories":
      case "add_directory":
      case "remove_directory": {
        const request = parsed.data as
          | SessionOperationRequest<"list_directories">
          | SessionOperationRequest<"add_directory">
          | SessionOperationRequest<"remove_directory">;
        const destination = target(request.target);
        const self =
          actor.kind === destination.kind &&
          actor.id === destination.id &&
          actor.incarnationId === destination.incarnationId;
        if (!self) {
          try {
            assertDirectChildSessionControl(actor, destination);
          } catch {
            throw new SessionManagementError(
              "SESSION_FORBIDDEN",
              "Directory management requires the actual Session or its direct child.",
            );
          }
        }
        context.assertCurrent();
        const change =
          operation === "list_directories"
            ? null
            : {
                operation:
                  operation === "add_directory"
                    ? ("add" as const)
                    : ("remove" as const),
                directoryPath: (
                  request as SessionOperationRequest<"add_directory">
                ).directoryPath,
              };
        return {
          ok: true,
          directories: await this.deps.directories(
            destination,
            change,
            context.assertCurrent,
          ),
        };
      }
      case "get_instructions": {
        // 上で保存済みの実行主体と認証済みバインディングの一致を確認済み。リクエストには対象の指定がない。
        const body = await this.deps.getInstructions(context.actor);
        context.assertCurrent();
        return { ok: true, body };
      }
      case "set_instructions": {
        // 不正なバイト列は処理を送出する前に拒否し、このエラーでは書き込みがないと確定できるようにする。
        let instructions: string;
        try {
          instructions = validateSessionInstructions(
            (parsed.data as SessionOperationRequest<"set_instructions">).body,
          );
        } catch (error) {
          // 何も変更していないと保証できるのは、既知の検証エラーの場合だけ。
          if (error instanceof TypeError || error instanceof RangeError) {
            return {
              ok: false,
              code: "SESSION_INVALID_REQUEST",
              effect: "none",
              message: error.message,
            };
          }
          throw error;
        }
        const { byteLength } = await this.deps.setInstructions(
          context.actor,
          instructions,
        );
        return { ok: true, byteLength };
      }
      case "update_metadata": {
        context.assertCurrent();
        return {
          ok: true,
          metadata: await this.deps.updateMetadata(
            actor,
            parsed.data as SessionOperationRequest<"update_metadata">,
            context.assertCurrent,
          ),
        };
      }
      case "enqueue": {
        const input = parsed.data as SessionOperationRequest<"enqueue">;
        const destination = target(input.target);
        try {
          assertDirectSessionSend(actor, destination);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Messages require actual direct parent-child Sessions.",
          );
        }
        if (
          destination.parentSessionId === actor.id &&
          (input.model === undefined || input.reasoningEffort === undefined)
        ) {
          throw new SessionManagementError(
            "SESSION_INVALID_REQUEST",
            "Parent-to-child messages require model and reasoningEffort (use an empty string for no Depth).",
          );
        }
        const current = await this.deps.currentTurn(actor);
        context.assertCurrent();
        if (!current.turnId)
          throw new SessionManagementError(
            "SESSION_TURN_UNAVAILABLE",
            "The actor has no current saved WithMate Turn.",
          );
        return {
          ok: true,
          receipt: await this.deps.enqueue(
            destination,
            input,
            actor,
            current.turnId,
            context.assertCurrent,
          ),
        };
      }
      case "steer": {
        const input = parsed.data as SessionOperationRequest<"steer">;
        const destination = target(input.target);
        try {
          assertDirectChildSessionControl(actor, destination);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Only an actual direct parent may Steer this normal child.",
          );
        }
        const current = await this.deps.currentTurn(actor);
        context.assertCurrent();
        if (!current.turnId)
          throw new SessionManagementError(
            "SESSION_TURN_UNAVAILABLE",
            "The actor has no current saved WithMate Turn.",
          );
        const result = await this.deps.steer(
          destination,
          input,
          actor,
          current.turnId,
          context.assertCurrent,
        );
        return result.outcome === "unknown"
          ? {
              ok: false,
              code: "SESSION_STEER_UNKNOWN",
              effect: "unknown",
              message: result.reason,
              result,
            }
          : { ok: true, result };
      }
      case "get_receipt": {
        const input = parsed.data as SessionOperationRequest<"get_receipt">;
        const destination = target(input.target);
        const receipt = await this.deps.getReceipt(
          destination,
          input.requestId,
        );
        context.assertCurrent();
        const origin = receipt?.accepted?.origin;
        if (
          receipt &&
          (!origin ||
            origin.kind !== "session" ||
            origin.actorKind !== actor.kind ||
            origin.actorSessionId !== actor.id ||
            origin.actorIncarnationId !== actor.incarnationId ||
            origin.operation !== "send" ||
            origin.targetSessionId !== destination.id ||
            origin.targetIncarnationId !== destination.incarnationId)
        )
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Request-key recovery is limited to the actual sender and target.",
          );
        return { ok: true, receipt };
      }
      case "cancel_receipt":
      case "stop_turn": {
        const input = parsed.data as
          | SessionOperationRequest<"cancel_receipt">
          | SessionOperationRequest<"stop_turn">;
        const destination = target(input.target);
        try {
          assertDirectChildSessionControl(actor, destination);
        } catch {
          throw new SessionManagementError(
            "SESSION_FORBIDDEN",
            "Only an actual direct parent may control this Session.",
          );
        }
        context.assertCurrent();
        return {
          ok: true,
          result:
            operation === "cancel_receipt"
              ? await this.deps.cancelReceipt(
                  destination,
                  (input as SessionOperationRequest<"cancel_receipt">)
                    .receiptId,
                  context.assertCurrent,
                )
              : await this.deps.stopTurn(
                  destination,
                  (input as SessionOperationRequest<"stop_turn">).turnId,
                  context.assertCurrent,
                ),
        };
      }
    }
  }
}
