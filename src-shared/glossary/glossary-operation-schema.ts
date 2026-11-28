import { z } from "zod";

import {
  GLOSSARY_LIMITS,
  GLOSSARY_RUNTIME_SCHEMA_VERSION,
} from "./glossary-contract.js";

/** 対象の種類に応じてチェックアウトIDまたはパスを要求する通信スキーマ。 */
export const glossaryCheckoutSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("primary") }).strict(),
  z
    .object({
      kind: z.literal("checkout"),
      checkoutId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      path: z.string().min(1).max(8192),
    })
    .strict(),
]);

/** 通信で受け取る語・別名・定義の型と粗い長さ制限。保存時の正規化とは別。 */
export const glossaryEntryInputSchema = z
  .object({
    term: z
      .string()
      .min(1)
      .max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
    aliases: z
      .array(
        z
          .string()
          .min(1)
          .max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
      )
      .max(GLOSSARY_LIMITS.maxAliasesPerEntry)
      .optional(),
    definition: z
      .string()
      .min(1)
      .max(GLOSSARY_LIMITS.maxDefinitionCodePoints * 4),
  })
  .strict();

const schemaVersion = z.literal(GLOSSARY_RUNTIME_SCHEMA_VERSION);
const selectedRequest = z
  .object({
    schemaVersion,
    selector: glossaryCheckoutSelectorSchema,
  })
  .strict();
const pageShape = {
  offset: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().min(1).max(GLOSSARY_LIMITS.maxPageSize).optional(),
};

/** 用語集操作ごとの通信入力。更新・削除には版と明示依頼の指定が必要。 */
export const glossaryOperationRequestSchemas = {
  list_targets: z
    .object({
      schemaVersion,
      selector: glossaryCheckoutSelectorSchema.optional(),
    })
    .strict(),
  list: selectedRequest.extend(pageShape).strict(),
  search: selectedRequest
    .extend({
      query: z.string().max(GLOSSARY_LIMITS.maxQueryCodePoints * 4),
      ...pageShape,
    })
    .strict(),
  get: selectedRequest
    .extend({
      termOrAlias: z
        .string()
        .min(1)
        .max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
    })
    .strict(),
  create: selectedRequest
    .extend({
      mode: z.enum(["explicit", "proactive"]),
      entry: glossaryEntryInputSchema,
    })
    .strict(),
  create_batch: selectedRequest
    .extend({
      mode: z.enum(["explicit", "proactive"]),
      entries: z
        .array(glossaryEntryInputSchema)
        .min(1)
        .max(GLOSSARY_LIMITS.maxBatchEntries),
    })
    .strict(),
  update: selectedRequest
    .extend({
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      targetTerm: z
        .string()
        .min(1)
        .max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
      entry: glossaryEntryInputSchema,
      explicitUserRequest: z.literal(true),
    })
    .strict(),
  delete: selectedRequest
    .extend({
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      targetTerm: z
        .string()
        .min(1)
        .max(GLOSSARY_LIMITS.maxTermCodePoints * 4),
      explicitUserRequest: z.literal(true),
    })
    .strict(),
  validate: selectedRequest,
} as const;

/** ランタイムへ送信できる用語集操作名。 */
export type GlossaryRuntimeOperation =
  keyof typeof glossaryOperationRequestSchemas;

/** 用語集操作名を、正規のバージョン付きHTTPパスに対応付ける。 */
export const GLOSSARY_RUNTIME_OPERATION_PATHS: Readonly<
  Record<GlossaryRuntimeOperation, string>
> = {
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

/** 受信したHTTPパスから用語集操作を特定する逆引き表。 */
export const glossaryRuntimeOperationByPath = new Map(
  Object.entries(GLOSSARY_RUNTIME_OPERATION_PATHS).map(
    ([operation, operationPath]) => [
      operationPath,
      operation as GlossaryRuntimeOperation,
    ],
  ),
);

/** 用語集の各操作を、実行時の照合に使う名前へ変換する。 */
export function glossaryAgentRuntimeOperation(
  operation: GlossaryRuntimeOperation,
): string {
  return `glossary.route.${operation}`;
}

/** 通信スキーマで公開されている全操作のランタイム名を返す。 */
export function getGlossaryAgentRuntimeOperations(): string[] {
  return Object.keys(glossaryOperationRequestSchemas).map((operation) =>
    glossaryAgentRuntimeOperation(operation as GlossaryRuntimeOperation),
  );
}
