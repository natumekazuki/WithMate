import { z } from "zod";

import {
  GLOSSARY_LIMITS,
  GLOSSARY_RUNTIME_SCHEMA_VERSION,
} from "./glossary-contract.js";

export const glossaryCheckoutSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("primary") }).strict(),
  z.object({ kind: z.literal("checkout"), checkoutId: z.string().min(1).max(256) }).strict(),
]);

export const glossaryEntryInputSchema = z.object({
  term: z.string().min(1).max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
  aliases: z.array(z.string().min(1).max(GLOSSARY_LIMITS.maxTermCodePoints * 4))
    .max(GLOSSARY_LIMITS.maxAliasesPerEntry)
    .optional(),
  definition: z.string().min(1).max(GLOSSARY_LIMITS.maxDefinitionCodePoints * 4),
}).strict();

const schemaVersion = z.literal(GLOSSARY_RUNTIME_SCHEMA_VERSION);
const selectedRequest = z.object({
  schemaVersion,
  selector: glossaryCheckoutSelectorSchema,
}).strict();
const pageShape = {
  offset: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().min(1).max(GLOSSARY_LIMITS.maxPageSize).optional(),
};

export const glossaryOperationRequestSchemas = {
  list_targets: z.object({ schemaVersion }).strict(),
  list: selectedRequest.extend(pageShape).strict(),
  search: selectedRequest.extend({
    query: z.string().max(GLOSSARY_LIMITS.maxQueryCodePoints * 4),
    ...pageShape,
  }).strict(),
  get: selectedRequest.extend({ termOrAlias: z.string().min(1).max(GLOSSARY_LIMITS.maxTermCodePoints * 4) }).strict(),
  create: selectedRequest.extend({
    mode: z.enum(["explicit", "proactive"]),
    entry: glossaryEntryInputSchema,
  }).strict(),
  create_batch: selectedRequest.extend({
    mode: z.enum(["explicit", "proactive"]),
    entries: z.array(glossaryEntryInputSchema).min(1).max(GLOSSARY_LIMITS.maxBatchEntries),
  }).strict(),
  update: selectedRequest.extend({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    targetTerm: z.string().min(1).max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
    entry: glossaryEntryInputSchema,
    explicitUserRequest: z.literal(true),
  }).strict(),
  delete: selectedRequest.extend({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    targetTerm: z.string().min(1).max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
    explicitUserRequest: z.literal(true),
  }).strict(),
  validate: selectedRequest,
} as const;

export type GlossaryRuntimeOperation = keyof typeof glossaryOperationRequestSchemas;

export const GLOSSARY_RUNTIME_OPERATION_PATHS: Readonly<Record<GlossaryRuntimeOperation, string>> = {
  list_targets: "/v1/glossary/list-targets",
  list: "/v1/glossary/list",
  search: "/v1/glossary/search",
  get: "/v1/glossary/get",
  create: "/v1/glossary/create",
  create_batch: "/v1/glossary/create-batch",
  update: "/v1/glossary/update",
  delete: "/v1/glossary/delete",
  validate: "/v1/glossary/validate",
};

export const glossaryRuntimeOperationByPath = new Map(
  Object.entries(GLOSSARY_RUNTIME_OPERATION_PATHS).map(([operation, operationPath]) => [
    operationPath,
    operation as GlossaryRuntimeOperation,
  ]),
);

export function glossaryAgentRuntimeOperation(operation: GlossaryRuntimeOperation): string {
  return `glossary.route.${operation}`;
}

export function getGlossaryAgentRuntimeOperations(): string[] {
  return Object.keys(glossaryOperationRequestSchemas)
    .map((operation) => glossaryAgentRuntimeOperation(operation as GlossaryRuntimeOperation));
}
