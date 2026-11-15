import { z } from "zod";
import {
  coordinationIdentitySchema,
  type CoordinationIdentity,
  type CoordinationRequest,
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
export type CoordinationWindowResult = CoordinationResult | {
  error: { code: "COORDINATION_DELETED"; message: string };
};
export type CoordinationWindowApi = {
  getCoordinationIdentity(identity: CoordinationIdentity): Promise<CoordinationDisplayIdentity | null>;
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
