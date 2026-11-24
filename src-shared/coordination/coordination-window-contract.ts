import { z } from "zod";
import {
  coordinationIdentitySchema,
  type CoordinationIdentity,
  type CoordinationRequest,
  type CoordinationRecord,
  type CoordinationResult,
  type CoordinationSummary,
} from "./coordination-contract.js";

/** Current Session display metadata, not a snapshot captured by the record. */
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
  /** Visible consultation status only; full user reads and Agent operations use their existing paths. */
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
