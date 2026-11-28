import { z } from "zod";
import {
  coordinationIdentitySchema,
  type CoordinationIdentity,
  type CoordinationRequest,
  type CoordinationRecord,
  type CoordinationResult,
  type CoordinationSummary,
} from "./coordination-contract.js";

/** 現時点の Session 表示用メタデータであり、レコードに記録されたスナップショットではない。 */
export type CoordinationDisplayIdentity = {
  title: string;
  character: { name: string; iconPath: string };
};

/** 開く画面のSessionの個体を必須とし、単一の相談を開く場合だけ相談IDを付ける。 */
export const openCoordinationRequestSchema = coordinationIdentitySchema
  .extend({ id: z.string().min(1).optional() })
  .strict();
/** 相談一覧または個別の相談を開くための画面起動要求。 */
export type OpenCoordinationRequest = z.infer<
  typeof openCoordinationRequestSchema
>;
/** 本文を含めず、変更された相談と再取得すべきCrew・開始Sessionを通知する。 */
export type CoordinationInvalidation = Pick<
  CoordinationSummary,
  "id" | "crewRootSessionId" | "initiator"
>;
/** 表示しようとした相談が削除済みであることを画面へ返す。 */
export type CoordinationDeletedResult = {
  error: { code: "COORDINATION_DELETED"; message: string };
};
/** 画面からの相談操作には、処理結果または削除済みの通知が返る。 */
export type CoordinationWindowResult =
  CoordinationResult | CoordinationDeletedResult;
/** 状態照会は相談IDだけを入力とし、更新内容や追加フィールドを受け付けない。 */
export const coordinationStatusRequestSchema = z
  .object({ id: z.string() })
  .strict();
/** 表示に必要な最小限の状態を問い合わせる相談ID。 */
export type CoordinationStatusRequest = z.infer<
  typeof coordinationStatusRequestSchema
>;
/** 画面に出す状態・回答者の種別・回答の有無。本文や回答内容は含まない。 */
export type CoordinationStatus = {
  state: CoordinationRecord["state"];
  respondentKind: CoordinationRecord["respondent"]["kind"];
  hasAnswer: boolean;
};
/** 状態照会の結果。削除済みの場合に空の状態を仮定せず専用の結果を返す。 */
export type CoordinationStatusResult =
  CoordinationStatus | CoordinationDeletedResult;
/** 相談画面が使う状態照会、操作、変更通知、画面起動の境界。 */
export type CoordinationWindowApi = {
  /** 保存された識別情報から現在の画面表示名を引き、見つからなければnullを返す。 */
  getCoordinationIdentity(
    identity: CoordinationIdentity,
  ): Promise<CoordinationDisplayIdentity | null>;
  /** 画面に表示する相談の状態のみ。ユーザーによる詳細の読み取りと Agent の操作は既存経路を使う。 */
  getCoordinationStatus(
    request: CoordinationStatusRequest,
  ): Promise<CoordinationStatusResult>;
  /** 画面から相談操作を要求し、削除済みの結果も画面で扱えるようにする。 */
  executeCoordination(
    request: CoordinationRequest,
  ): Promise<CoordinationWindowResult>;
  /** 変更を受けた相談の最小情報を購読し、解除関数を返す。 */
  subscribeCoordinationChanged(
    listener: (summary: CoordinationInvalidation) => void,
  ): () => void;
  /** 指定Sessionの相談一覧、または指定IDの相談を開く。 */
  openCoordination(request: OpenCoordinationRequest): Promise<void>;
  /** 画面を開く要求を受け取り、解除関数を返す。 */
  subscribeOpenCoordination(
    listener: (request: OpenCoordinationRequest) => void,
  ): () => void;
};
