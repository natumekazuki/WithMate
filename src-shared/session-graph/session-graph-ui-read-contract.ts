import { z } from "zod";
import { sessionGraphOperationRequestSchemas, sessionGraphRelationSchema } from "./session-graph-operation-schema.js";
import type { SessionGraphConflict, SessionGraphEndpoint, SessionGraphIdentity, SessionGraphOperation, SessionGraphOperationResult, SessionGraphPage, SessionGraphReadResult, SessionGraphRecord, SessionGraphRelation, SessionGraphTopic } from "./session-graph-contract.js";

const page = { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().nonnegative().optional(), expectedRevision: z.number().int().nonnegative().optional() };
const topicId = z.string().min(1).max(256);
export const sessionGraphOverviewCategorySchema = z.enum(["requirements", "constraints", "decisions", "activities", "observations", "issues"]);
export type SessionGraphOverviewCategory = z.infer<typeof sessionGraphOverviewCategorySchema>;
export const sessionGraphUiReadRequestSchemas = {
  list_topics: sessionGraphOperationRequestSchemas.list_topics,
  recent: sessionGraphOperationRequestSchemas.recent,
  context: sessionGraphOperationRequestSchemas.context,
  get: sessionGraphOperationRequestSchemas.get,
  search: sessionGraphOperationRequestSchemas.search,
  get_topic_view: sessionGraphOperationRequestSchemas.get_topic_view,
  overview: z.object({ ...page }).strict(),
  topic_records: z.object({ ...page, topicId, category: sessionGraphOverviewCategorySchema, actorSessionId: topicId.optional() }).strict(),
  topic_relations: z.object({ ...page, fromTopicId: topicId, toTopicId: topicId, kind: sessionGraphRelationSchema.shape.kind }).strict(),
} as const;
export type SessionGraphUiReadOperation = keyof typeof sessionGraphUiReadRequestSchemas;
export type SessionGraphUiReadRequest<K extends SessionGraphUiReadOperation> = z.infer<(typeof sessionGraphUiReadRequestSchemas)[K]>;
export type SessionGraphRecencyRange = { oldestUpdatedAt?: string; newestUpdatedAt?: string };
export type SessionGraphRecordSummary = Pick<SessionGraphRecord, "id" | "topicId" | "title" | "kind" | "adoption" | "progress" | "result" | "resolution" | "validity" | "updatedAt">;
export type SessionGraphOverviewGroup = { count: number; states: Record<string, number>; records: SessionGraphRecordSummary[] };
export type SessionGraphTopicOverview = SessionGraphTopic & {
  recordCount: number;
  recency: SessionGraphRecencyRange;
  latestRecordUpdatedAt?: string;
  requirements: SessionGraphOverviewGroup;
  constraints: SessionGraphOverviewGroup;
  decisions: SessionGraphOverviewGroup;
  activities: SessionGraphOverviewGroup;
  observations: SessionGraphOverviewGroup;
  issues: SessionGraphOverviewGroup;
  actors: Array<{ identity: SessionGraphIdentity; activities: SessionGraphOverviewGroup }>;
};
export type SessionGraphTopicRelation = { fromTopicId: string; toTopicId: string; kind: SessionGraphRelation["kind"]; count: number };
export type SessionGraphOverviewResult = SessionGraphPage<SessionGraphTopicOverview> & {
  recency: SessionGraphRecencyRange;
  topicRelations: SessionGraphTopicRelation[];
};
export type SessionGraphTopicRelationsResult = SessionGraphPage<SessionGraphRelation> & { endpoints: SessionGraphEndpoint[] };
export type SessionGraphUiReadResult<K extends SessionGraphUiReadOperation> = K extends "overview" ? SessionGraphOverviewResult | SessionGraphConflict
  : K extends "topic_relations" ? SessionGraphTopicRelationsResult | SessionGraphConflict
  : K extends "topic_records" ? SessionGraphPage<SessionGraphRecordSummary> | SessionGraphConflict
  : K extends "get_topic_view" ? (SessionGraphReadResult & { recency: SessionGraphRecencyRange }) | SessionGraphConflict
  : K extends SessionGraphOperation ? SessionGraphOperationResult<K> : never;
export const sessionGraphStorageRequestSchemas = { ...sessionGraphOperationRequestSchemas, ...sessionGraphUiReadRequestSchemas } as const;
export type SessionGraphStorageOperation = keyof typeof sessionGraphStorageRequestSchemas;
export type SessionGraphStorageRequest<K extends SessionGraphStorageOperation> = z.infer<(typeof sessionGraphStorageRequestSchemas)[K]>;
export type SessionGraphStorageResult<K extends SessionGraphStorageOperation> = K extends SessionGraphUiReadOperation ? SessionGraphUiReadResult<K>
  : K extends SessionGraphOperation ? SessionGraphOperationResult<K> : never;
