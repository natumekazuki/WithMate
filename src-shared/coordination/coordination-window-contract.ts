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

export const openCoordinationRequestSchema = coordinationIdentitySchema
  .extend({ id: z.string().min(1).optional() })
  .strict();
export type OpenCoordinationRequest = z.infer<
  typeof openCoordinationRequestSchema
>;
export type CoordinationInvalidation = Pick<
  CoordinationSummary,
  "id" | "crewRootSessionId" | "initiator"
>;
export type CoordinationDeletedResult = {
  error: { code: "COORDINATION_DELETED"; message: string };
};
export type CoordinationWindowResult = CoordinationResult | CoordinationDeletedResult;
export const coordinationStatusRequestSchema = z.object({ id: z.string() }).strict();
export type CoordinationStatusRequest = z.infer<typeof coordinationStatusRequestSchema>;
export type CoordinationStatus = {
  state: CoordinationRecord["state"];
  respondentKind: CoordinationRecord["respondent"]["kind"];
  hasAnswer: boolean;
};
export type CoordinationStatusResult = CoordinationStatus | CoordinationDeletedResult;
export type CoordinationWindowApi = {
  getCoordinationIdentity(identity: CoordinationIdentity): Promise<CoordinationDisplayIdentity | null>;
  /** 画面に表示する相談の状態のみ。ユーザーによる詳細の読み取りと Agent の操作は既存経路を使う。 */
  getCoordinationStatus(request: CoordinationStatusRequest): Promise<CoordinationStatusResult>;
  executeCoordination(
    request: CoordinationRequest,
  ): Promise<CoordinationWindowResult>;
  subscribeCoordinationChanged(
    listener: (summary: CoordinationInvalidation) => void,
  ): () => void;
  openCoordination(request: OpenCoordinationRequest): Promise<void>;
  subscribeOpenCoordination(
    listener: (request: OpenCoordinationRequest) => void,
  ): () => void;
};
