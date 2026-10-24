import { z } from "zod";

const id = z.string().min(1).max(256);
const text = z.string().max(100_000);
export type SessionGraphJsonValue = string | number | boolean | null | SessionGraphJsonValue[] | { [key: string]: SessionGraphJsonValue };
const json: z.ZodType<SessionGraphJsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));
export const sessionGraphActorSchema = z.union([
  z.object({ sessionId: id }).strict(), z.object({ label: z.string().min(1).max(512) }).strict(),
]);
export const sessionGraphRecordInputSchema = z.object({
  id, topicId: id, kind: z.enum(["requirement", "constraint", "decision", "activity", "observation", "issue"]),
  title: z.string().min(1).max(1024), detail: text, scope: z.string().max(4096), actor: sessionGraphActorSchema,
  target: z.object({ revision: z.string().max(1024), conditions: text, observedAt: z.string().datetime() }).strict().optional(),
  references: z.array(z.object({ role: z.enum(["evidence", "artifact", "handoff"]), label: z.string().max(1024), href: z.string().min(1).max(8192) }).strict()).max(100),
  fields: z.record(z.string(), json).optional(),
  adoption: z.enum(["proposed", "accepted", "declined"]).optional(),
  progress: z.enum(["planned", "in_progress", "completed", "paused", "canceled"]).optional(),
  result: z.enum(["reported", "checked", "passed", "failed", "not_run", "unknown"]).optional(),
  resolution: z.enum(["open", "resolved"]).optional(), validity: z.enum(["superseded", "withdrawn"]).optional(),
}).strict();
export const sessionGraphRelationSchema = z.object({ id, fromId: id, toId: id, kind: z.enum(["fulfills", "constrains", "supports", "checks", "depends_on", "supersedes", "related"]), label: z.string().max(1024).optional() }).strict();
const page = { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().nonnegative().optional(), expectedRevision: z.number().int().nonnegative().optional() };
const filters = { topicId: id.optional(), actorSessionId: id.optional(), recordedBySessionId: id.optional(),
  kind: sessionGraphRecordInputSchema.shape.kind.optional(), adoption: sessionGraphRecordInputSchema.shape.adoption,
  progress: sessionGraphRecordInputSchema.shape.progress, result: sessionGraphRecordInputSchema.shape.result, resolution: sessionGraphRecordInputSchema.shape.resolution };
export const sessionGraphOperationRequestSchemas = {
  list_topics: z.object({ ...page }).strict(),
  recent: z.object({ ...page, ...filters }).strict(),
  context: z.object({ ...page, ...filters }).strict(),
  get: z.object({ ...page, ids: z.array(id).min(1).max(200) }).strict(),
  search: z.object({ ...page, ...filters, query: z.string().min(1).max(1024) }).strict(),
  get_topic_view: z.object({ ...page, ...filters, topicId: id }).strict(),
  apply: z.object({ expectedRevision: z.number().int().nonnegative(),
    topics: z.array(z.object({ id, title: z.string().min(1).max(1024) }).strict()).max(100).optional(),
    records: z.array(sessionGraphRecordInputSchema).max(200).optional(),
    relations: z.array(sessionGraphRelationSchema).max(400).optional(),
    removeRelationIds: z.array(id).max(400).optional(),
  }).strict(),
} as const;
export type SessionGraphRuntimeOperation = keyof typeof sessionGraphOperationRequestSchemas;
export const SESSION_GRAPH_RUNTIME_OPERATION_PATHS = Object.fromEntries(Object.keys(sessionGraphOperationRequestSchemas).map((key) => [key, `/v1/session-graph/${key.replaceAll("_", "-")}`])) as Record<SessionGraphRuntimeOperation, string>;
export const sessionGraphRuntimeOperationByPath = new Map(Object.entries(SESSION_GRAPH_RUNTIME_OPERATION_PATHS).map(([key, path]) => [path, key as SessionGraphRuntimeOperation]));
export function sessionGraphAgentRuntimeOperation(operation: SessionGraphRuntimeOperation): string { return `session_graph.route.${operation}`; }
export function getSessionGraphAgentRuntimeOperations(): string[] { return Object.keys(sessionGraphOperationRequestSchemas).map((key) => sessionGraphAgentRuntimeOperation(key as SessionGraphRuntimeOperation)); }
