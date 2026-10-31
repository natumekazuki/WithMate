import type { z } from "zod";
import type { sessionGraphOperationRequestSchemas, sessionGraphRecordInputSchema, sessionGraphRecordSchema, sessionGraphRelationSchema } from "./session-graph-operation-schema.js";

export type SessionGraphOwner = { sessionId: string; incarnationId: string };
export const SESSION_GRAPH_RELATION_LIMIT = 400;
export type SessionGraphIdentity = {
  sessionId: string; sessionTitle: string; role: "main" | "auxiliary";
  character?: { id: string; name: string; icon?: string; theme?: { main: string; sub: string } };
};
export type SessionGraphRecordInput = z.infer<typeof sessionGraphRecordInputSchema>;
export type SessionGraphRecord = z.infer<typeof sessionGraphRecordSchema> & {
  actorSnapshot: SessionGraphIdentity;
  recordedBy: SessionGraphIdentity;
  createdAt: string; updatedAt: string;
};
export type SessionGraphTopic = { id: string; title: string; createdAt: string; updatedAt: string };
export type SessionGraphRelation = z.infer<typeof sessionGraphRelationSchema>;
export type SessionGraphEndpoint = Pick<SessionGraphRecord, "id" | "topicId" | "title" | "kind" | "validity">;
export type SessionGraphConflict = { status: "conflict"; revision: number };
export type SessionGraphPage<T> = { status: "ok"; revision: number; items: T[]; total: number; offset: number; hasMore: boolean; incomplete: boolean };
export type SessionGraphReadResult = SessionGraphPage<SessionGraphRecord> & {
  relations: SessionGraphRelation[]; externalEndpoints: SessionGraphEndpoint[]; relationsTruncated: boolean;
  relationOffset: number; relationsHasMore: boolean;
};
export type SessionGraphApplyResult = { status: "ok"; revision: number } | SessionGraphConflict;
export type SessionGraphOperation = keyof typeof sessionGraphOperationRequestSchemas;
export type SessionGraphRequest<K extends SessionGraphOperation> = z.infer<(typeof sessionGraphOperationRequestSchemas)[K]>;
export type SessionGraphOperationResult<K extends SessionGraphOperation> = K extends "apply" ? SessionGraphApplyResult
  : K extends "list_topics" ? SessionGraphPage<SessionGraphTopic> | SessionGraphConflict
  : SessionGraphReadResult | SessionGraphConflict;
