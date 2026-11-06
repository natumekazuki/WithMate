import { z } from "zod";
import {
  coordinationIdentitySchema,
  type CoordinationRequest,
  type CoordinationResult,
  type CoordinationSummary,
} from "./coordination-contract.js";

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
