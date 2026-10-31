import { z } from "zod";
import { isSessionGraphReferenceHref } from "./session-graph-reference.js";

const id = z.string().min(1).max(256);
const text = z.string().max(100_000);
export type SessionGraphJsonValue = string | number | boolean | null | SessionGraphJsonValue[] | { [key: string]: SessionGraphJsonValue };
const json: z.ZodType<SessionGraphJsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));
export const sessionGraphActorSchema = z.object({ sessionId: id }).strict();
export const sessionGraphOriginSchema = z.object({
  type: z.enum(["agent", "user", "external"]), label: z.string().min(1).max(512).optional(),
}).strict();
export const sessionGraphRecordSchema = z.object({
  id, topicId: id, kind: z.enum(["requirement", "constraint", "decision", "activity", "observation", "issue"]),
  title: z.string().min(1).max(1024), detail: text, scope: z.string().max(4096), actor: sessionGraphActorSchema,
  origin: sessionGraphOriginSchema,
  adoptionOrigin: sessionGraphOriginSchema.optional(),
  actorRole: z.string().min(1).max(512).optional(),
  target: z.object({ revision: z.string().max(1024), conditions: text, observedAt: z.string().datetime() }).strict().optional(),
  references: z.array(z.object({ role: z.enum(["evidence", "artifact", "handoff"]), label: z.string().max(1024), href: z.string().min(1).max(8192).refine(isSessionGraphReferenceHref, "Use an absolute file path or a complete file/http/https/mailto/tel URL.") }).strict()).max(100),
  fields: z.record(z.string(), json).optional(),
  adoption: z.enum(["proposed", "accepted", "declined"]).optional(),
  progress: z.enum(["planned", "in_progress", "completed", "paused", "canceled"]).optional(),
  result: z.enum(["reported", "checked", "passed", "failed", "not_run", "unknown"]).optional(),
  resolution: z.enum(["open", "resolved"]).optional(), validity: z.enum(["superseded", "withdrawn"]).optional(),
}).strict();
// Omitted optional attributes survive updates; null explicitly removes them.
export const sessionGraphRecordInputSchema = sessionGraphRecordSchema.extend({
  actor: sessionGraphActorSchema.optional(), origin: sessionGraphOriginSchema.optional(),
  adoptionOrigin: sessionGraphRecordSchema.shape.adoptionOrigin.nullable(),
  actorRole: sessionGraphRecordSchema.shape.actorRole.nullable(),
  target: sessionGraphRecordSchema.shape.target.nullable(), fields: sessionGraphRecordSchema.shape.fields.nullable(),
  adoption: sessionGraphRecordSchema.shape.adoption.nullable(), progress: sessionGraphRecordSchema.shape.progress.nullable(),
  result: sessionGraphRecordSchema.shape.result.nullable(), resolution: sessionGraphRecordSchema.shape.resolution.nullable(),
  validity: sessionGraphRecordSchema.shape.validity.nullable(),
});
export const sessionGraphRelationSchema = z.object({
  id: id.describe("Stable relation ID: reuse it to update kind, label or endpoints; remove it with removeRelationIds."),
  fromId: id.describe("Source record ID; both endpoints must exist in this parent Graph, including records in the same atomic apply."),
  toId: id.describe("Target record ID; may belong to another topic in this parent Graph."),
  kind: z.enum(["fulfills", "constrains", "supports", "checks", "depends_on", "supersedes", "related"]).describe("fulfills: activity -> requirement; checks: observation -> checked target; supports: evidence -> decision/target; depends_on: dependent -> prerequisite; constrains: constraint -> target; supersedes: successor -> old record; related: other explicit connection. Relations never change record state automatically."),
  label: z.string().max(1024).optional(),
}).strict();
const page = { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().nonnegative().optional(), expectedRevision: z.number().int().nonnegative().optional() };
const recordPage = { ...page, relationOffset: z.number().int().nonnegative().optional().describe("Independent offset into relations touching returned items, ordered by stable relation ID (400 per read). Keep record filters/offset/limit and expectedRevision unchanged for continuation. Only a complete sequence from zero to relationsHasMore=false confirms absence within returned item IDs.") };
const filters = { topicId: id.optional(), actorSessionId: id.optional(), recordedBySessionId: id.optional(),
  kind: sessionGraphRecordSchema.shape.kind.optional(), adoption: sessionGraphRecordSchema.shape.adoption,
  progress: sessionGraphRecordSchema.shape.progress, result: sessionGraphRecordSchema.shape.result, resolution: sessionGraphRecordSchema.shape.resolution };
export const sessionGraphOperationRequestSchemas = {
  list_topics: z.object({ ...page }).strict(),
  recent: z.object({ ...recordPage, ...filters }).strict(),
  context: z.object({ ...recordPage, ...filters }).strict(),
  get: z.object({ ...recordPage, ids: z.array(id).min(1).max(200) }).strict(),
  search: z.object({ ...recordPage, ...filters, query: z.string().min(1).max(1024) }).strict(),
  get_topic_view: z.object({ ...recordPage, ...filters, topicId: id }).strict(),
  apply: z.object({ expectedRevision: z.number().int().nonnegative(),
    topics: z.array(z.object({ id, title: z.string().min(1).max(1024) }).strict()).max(100).optional(),
    records: z.array(sessionGraphRecordInputSchema).max(200).optional(),
    relations: z.array(sessionGraphRelationSchema).max(400).optional().describe("Explicit meaningful connections, saved atomically with records. Isolated records are valid; never infer relations from title, topic, actor, time or origin."),
    removeRelationIds: z.array(id).max(400).optional().describe("Remove known stable relation IDs in the same revision-checked atomic batch."),
  }).strict(),
} as const;
export type SessionGraphRuntimeOperation = keyof typeof sessionGraphOperationRequestSchemas;
export const SESSION_GRAPH_RUNTIME_OPERATION_PATHS = Object.fromEntries(Object.keys(sessionGraphOperationRequestSchemas).map((key) => [key, `/v1/session-graph/${key.replaceAll("_", "-")}`])) as Record<SessionGraphRuntimeOperation, string>;
export const sessionGraphRuntimeOperationByPath = new Map(Object.entries(SESSION_GRAPH_RUNTIME_OPERATION_PATHS).map(([key, path]) => [path, key as SessionGraphRuntimeOperation]));
export function sessionGraphAgentRuntimeOperation(operation: SessionGraphRuntimeOperation): string { return `session_graph.route.${operation}`; }
export function getSessionGraphAgentRuntimeOperations(): string[] { return Object.keys(sessionGraphOperationRequestSchemas).map((key) => sessionGraphAgentRuntimeOperation(key as SessionGraphRuntimeOperation)); }
