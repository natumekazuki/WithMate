import { z } from "zod";
import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueReceipt,
} from "../session/session-turn-queue.js";
import type { SessionTarget } from "../session/session-target.js";

/** Sessionの種別・保存ID・incarnationを揃え、置き換わったSessionと区別する入力。 */
export const coordinationIdentitySchema = z
  .object({
    kind: z.enum(["main", "auxiliary"]),
    sessionId: z.string().min(1),
    incarnationId: z.string().min(1),
  })
  .strict();
/** MainまたはAuxiliaryの個体を参照する保存済み識別情報。 */
export type CoordinationIdentity = z.infer<typeof coordinationIdentitySchema>;
/** 操作の主体。Agentの場合はSessionの個体に加え、操作を行ったTurnを記録する。 */
export type CoordinationActor =
  { kind: "user" } | (CoordinationIdentity & { turnId: string });
/** 回答者の指定はユーザー、または識別情報をすべて持つSessionに限る。 */
export const coordinationRespondentSchema = z.union([
  z.object({ kind: z.literal("user") }).strict(),
  coordinationIdentitySchema,
]);
/** 回答を求めるユーザーまたはSessionの個体。実行したTurnの情報は含まない。 */
export type CoordinationRespondent = z.infer<
  typeof coordinationRespondentSchema
>;
/** 報告、判断、障害、訂正など、相談記録を作る目的の分類。 */
export const coordinationKindSchema = z.enum([
  "progress",
  "decision",
  "escalation",
  "user_decision_required",
  "blocker",
  "result",
  "correction",
]);
const text = z.string().min(1).max(32000);
const operationId = z.string().uuid();
/** 操作ごとの入力を検証し、回答の更新には読取時の回答revisionを要求する。 */
export const coordinationRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list"),
      crewRootSessionId: z.string().optional(),
      allCrews: z.boolean().optional(),
      sessionId: z.string().optional(),
      mainSessionId: z.string().optional(),
      userPending: z.boolean().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  z.object({ operation: z.literal("get"), id: z.string() }).strict(),
  z
    .object({ operation: z.literal("deliver"), operationId, id: z.string() })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      operationId,
      kind: coordinationKindSchema,
      body: text,
      choices: z.array(text).max(30).default([]),
      respondent: coordinationRespondentSchema.optional(),
      deliver: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      operation: z.literal("escalate"),
      operationId,
      id: z.string(),
      body: text,
    })
    .strict(),
  z
    .object({
      operation: z.literal("answer"),
      operationId,
      id: z.string(),
      body: text,
      selectedChoices: z.array(z.string()).max(30).default([]),
      expectedAnswerRevision: z.number().int().nonnegative(),
      send: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("withdraw"),
      operationId,
      id: z.string(),
      reason: z.string().max(32000).default(""),
    })
    .strict(),
  z
    .object({ operation: z.literal("resolve"), operationId, id: z.string() })
    .strict(),
  z
    .object({
      operation: z.literal("consume"),
      operationId,
      id: z.string(),
      answerId: z.string(),
      answerRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("correct"),
      operationId,
      id: z.string(),
      body: text,
    })
    .strict(),
]);
/** 既定値を補った後の相談操作。対象や配送の指定は操作によって異なる。 */
export type CoordinationRequest = z.infer<typeof coordinationRequestSchema>;
/** 本文と選択を保持する回答の一版。受領や消費、対応する配送があれば記録する。 */
export type CoordinationAnswer = {
  id: string;
  revision: number;
  actor: CoordinationActor;
  body: string;
  selectedChoices: string[];
  createdAt: string;
  receiptId?: string;
  acquiredAt?: string;
  consumedByOperationId?: string;
};
/** 相談が属するCrew、開始者と回答者、本文、状態の遷移と回答履歴を持つ保存レコード。 */
export type CoordinationRecord = {
  id: string;
  crewRootSessionId: string;
  kind: z.infer<typeof coordinationKindSchema>;
  initiator: CoordinationIdentity;
  initiatorTurnId: string;
  originReceiptId: string | null;
  caller: CoordinationIdentity | null;
  body: string;
  choices: string[];
  respondent: CoordinationRespondent;
  state: "open" | "resolved" | "withdrawn" | "corrected";
  withdrawalReason?: string;
  escalationBody?: string;
  correctionId?: string;
  answerRevision: number;
  answers: CoordinationAnswer[];
  createdAt: string;
  updatedAt: string;
};
/** 本文・選択肢・回答を含まない一覧項目。本文のプレビューと開始側のMain IDを添える。 */
export type CoordinationSummary = Omit<
  CoordinationRecord,
  "body" | "choices" | "answers"
> & { initiatorMainSessionId: string; bodyPreview: string };
/** 単一の相談レコードと任意の配送情報、または次の取得位置を伴う一覧ページ。 */
export type CoordinationResult =
  | {
      record: CoordinationRecord;
      receipt?: SessionTurnQueueReceipt;
      initiatorTarget?: SessionTarget;
    }
  | { items: CoordinationSummary[]; total: number; nextOffset: number | null };
/** 公開用の相談結果に、ストレージ操作に伴って更新された受付情報を添える。 */
export type CoordinationStorageResult = CoordinationResult & {
  queueUpdates?: SessionTurnQueueReceipt[];
};
/** アプリケーション内部の信頼済み入力。このラッパーを MCP・CLI・renderer から受け取らない。 */
export type CoordinationStorageInput = {
  actor: CoordinationActor;
  request: CoordinationRequest;
  defaultCrewRootSessionId?: string;
  delivery?: {
    target: CoordinationIdentity;
    captured: SessionTurnQueueCapturedInput;
  };
};
/** 相談の永続操作と、配送入力を組み立てる前に配送先を調べるための境界。 */
export type CoordinationStore = {
  /** 信頼済みの操作を保存層で実行し、必要なら変更された配送受付も返す。 */
  execute(input: CoordinationStorageInput): Promise<CoordinationStorageResult>;
  /** 操作と主体から配送先を求め、配送先がなければnullを返す。配送自体は行わない。 */
  deliveryTarget(
    input: Omit<CoordinationStorageInput, "delivery">,
  ): Promise<CoordinationIdentity | null>;
};
