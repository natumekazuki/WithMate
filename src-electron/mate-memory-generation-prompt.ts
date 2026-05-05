import type { AuditLogicalPrompt, AuditTransportPayload } from "../src/app-state.js";
import type { ModelReasoningEffort } from "../src/model-catalog.js";

export const MATE_MEMORY_GENERATION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string" },
          growthSourceType: {
            type: "string",
            enum: [
              "explicit_user_instruction",
              "user_correction",
              "repeated_user_behavior",
              "assistant_inference",
              "tool_or_file_observation",
            ],
          },
          kind: {
            type: "string",
            enum: [
              "conversation",
              "preference",
              "relationship",
              "work_style",
              "boundary",
              "project_context",
              "curiosity",
              "observation",
              "correction",
            ],
          },
          targetSection: {
            type: "string",
            enum: ["bond", "work_style", "project_digest", "core", "none"],
          },
          confidence: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          salienceScore: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          tags: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                value: { type: "string" },
              },
              required: ["type", "value"],
            },
          },
          relation: {
            type: "string",
            enum: ["new", "reinforces", "updates", "contradicts"],
          },
          relatedRefs: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["memory", "profile_item"] },
                    id: { type: "string" },
                  },
                  required: ["type", "id"],
                },
              ],
            },
          },
          supersedesRefs: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: { type: "string", enum: ["memory", "profile_item"] },
                    id: { type: "string" },
                  },
                  required: ["type", "id"],
                },
              ],
            },
          },
          targetClaimKey: { type: "string" },
          newTags: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                value: { type: "string" },
                reason: { type: "string" },
              },
              required: ["type", "value", "reason"],
            },
          },
          remember: { type: "boolean" },
          sourceType: {
            type: "string",
            enum: ["session", "companion", "manual", "system", "mate_talk"],
          },
          sourceSessionId: { anyOf: [{ type: "string" }, { type: "null" }] },
          sourceAuditLogId: { anyOf: [{ type: "integer" }, { type: "null" }] },
          projectDigestId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: [
          "statement",
          "growthSourceType",
          "kind",
          "targetSection",
          "confidence",
          "salienceScore",
          "tags",
          "relation",
          "relatedRefs",
          "supersedesRefs",
          "targetClaimKey",
          "newTags",
          "remember",
          "sourceType",
          "sourceSessionId",
          "sourceAuditLogId",
          "projectDigestId",
        ],
      },
    },
  },
  required: ["memories"],
} as const;

type TagCatalogEntry = {
  tagType: string;
  tagValue: string;
  tagValueNormalized?: string | null;
  description?: string | null;
  aliases?: string | null;
  usageCount?: number;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  disabledAt?: string | null;
};

export type MateMemoryGenerationTag = {
  type: string;
  value: string;
};

export type MateMemoryGenerationRelevantMemory = {
  id: string;
  state?: string;
  kind: string;
  targetSection: string;
  relation?: string;
  targetClaimKey?: string;
  statement: string;
  salienceScore: number;
  updatedAt: string;
  tags: readonly MateMemoryGenerationTag[];
};

export type MateMemoryGenerationRelevantProfileItem = {
  id: string;
  sectionKey: string;
  category: string;
  claimKey: string;
  renderedText: string;
  salienceScore: number;
  updatedAt: string;
  tags: readonly MateMemoryGenerationTag[];
};

export type MateMemoryGenerationForgottenTombstone = {
  id: string;
  digestKind: string;
  category: string;
  sectionKey: string;
  projectDigestId: string | null;
  sourceGrowthEventId: string | null;
  sourceProfileItemId: string | null;
  createdAt: string;
};

export type MateMemoryGenerationPromptInput = {
  recentConversationText: string;
  existingTagCatalog: readonly TagCatalogEntry[];
  relevantMemories?: readonly MateMemoryGenerationRelevantMemory[];
  relevantProfileItems?: readonly MateMemoryGenerationRelevantProfileItem[];
  forgottenTombstones?: readonly MateMemoryGenerationForgottenTombstone[];
  sourceDefaults?: {
    sourceType?: string | null;
    sourceSessionId?: string | null;
    sourceAuditLogId?: number | null;
    projectDigestId?: string | null;
  };
  mateName?: string;
  mateSummary?: string;
};

export type MateMemoryGenerationPrompt = {
  systemText: string;
  userText: string;
  outputSchema: typeof MATE_MEMORY_GENERATION_OUTPUT_SCHEMA;
};

export type MateMemoryGenerationResolvedSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  timeoutSeconds: number;
};

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizeTextOrNull(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeTagCatalogField(value: string | null | undefined): string | null {
  const normalized = normalizeText(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
}

const SNAPSHOT_TEXT_MAX_LENGTH = 400;
const SNAPSHOT_SHORT_TEXT_MAX_LENGTH = 200;

function sanitizeSnapshotField(value: string | null | undefined, maxLength: number): string {
  const normalized = normalizeText(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length === 0) {
    return "";
  }

  if (normalized.length > maxLength) {
    return `${normalized.slice(0, maxLength)}...`;
  }

  return normalized;
}

function sanitizeSnapshotId(value: string | null | undefined): string {
  return normalizeText(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSnapshotTag(tag: MateMemoryGenerationTag): { type: string; value: string } {
  return {
    type: sanitizeSnapshotField(tag.type, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    value: sanitizeSnapshotField(tag.value, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
  };
}

function sanitizeSnapshotOptionalField(
  value: string | null | undefined,
  maxLength: number,
): string | undefined {
  const normalized = sanitizeSnapshotField(value, maxLength);
  return normalized.length > 0 ? normalized : undefined;
}

function formatTagCatalogField(value: string): string {
  return JSON.stringify(value);
}

function buildTagCatalogMetadataLines(entry: TagCatalogEntry): string[] {
  const lines: string[] = [];
  const tagValueNormalized = normalizeTagCatalogField(entry.tagValueNormalized)
    ?? normalizeTagCatalogField(entry.tagValue);
  const description = normalizeTagCatalogField(entry.description);
  const aliases = normalizeTagCatalogField(entry.aliases);
  const createdBy = normalizeTagCatalogField(entry.createdBy);
  const createdAt = normalizeTagCatalogField(entry.createdAt);
  const updatedAt = normalizeTagCatalogField(entry.updatedAt);

  if (tagValueNormalized !== null) {
    lines.push(`tagValueNormalized: ${formatTagCatalogField(tagValueNormalized)}`);
  }
  if (description !== null) {
    lines.push(`description: ${formatTagCatalogField(description)}`);
  }
  if (aliases !== null) {
    lines.push(`aliases: ${formatTagCatalogField(aliases)}`);
  }
  if (entry.usageCount != null && Number.isFinite(entry.usageCount)) {
    lines.push(`usageCount: ${entry.usageCount}`);
  }
  if (createdBy !== null) {
    lines.push(`createdBy: ${formatTagCatalogField(createdBy)}`);
  }
  if (createdAt !== null) {
    lines.push(`createdAt: ${formatTagCatalogField(createdAt)}`);
  }
  if (updatedAt !== null) {
    lines.push(`updatedAt: ${formatTagCatalogField(updatedAt)}`);
  }

  return lines;
}

function resolveTagCatalogDedupKey(entry: TagCatalogEntry): string {
  const type = normalizeText(entry.tagType);
  if (!type) {
    return "";
  }
  const value = normalizeTextOrNull(entry.tagValueNormalized) ?? normalizeText(entry.tagValue);
  if (!value) {
    return "";
  }
  return `${type.toLowerCase()}\u0000${value.toLowerCase()}`;
}

function renderTagCatalog(entries: readonly TagCatalogEntry[]): string {
  if (entries.length === 0) {
    return "(既存 tag catalog はありません)";
  }

  const uniq = new Set<string>();
  const lines: string[] = [];

  for (const entry of entries) {
    const type = normalizeTagCatalogField(entry.tagType);
    const value = normalizeTagCatalogField(entry.tagValue);
    const key = resolveTagCatalogDedupKey(entry);
    if (!type || !value || !key) {
      continue;
    }

    if (uniq.has(key)) {
      continue;
    }

    uniq.add(key);
    lines.push(`- tagType: ${formatTagCatalogField(type)}, tagValue: ${formatTagCatalogField(value)}`);
    for (const line of buildTagCatalogMetadataLines(entry)) {
      lines.push(`  ${line}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(既存 tag catalog はありません)";
}

function normalizeRelevantMemorySnapshots(memories: readonly MateMemoryGenerationRelevantMemory[] = []): string {
  if (memories.length === 0) {
    return "(関連 Memory snapshot はありません)";
  }

  return JSON.stringify(memories.map((memory) => ({
    id: sanitizeSnapshotId(memory.id),
    state: sanitizeSnapshotOptionalField(memory.state, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    kind: sanitizeSnapshotField(memory.kind, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    targetSection: sanitizeSnapshotField(memory.targetSection, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    relation: sanitizeSnapshotOptionalField(memory.relation, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    targetClaimKey: sanitizeSnapshotOptionalField(memory.targetClaimKey, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    statement: sanitizeSnapshotField(memory.statement, SNAPSHOT_TEXT_MAX_LENGTH),
    salienceScore: memory.salienceScore,
    updatedAt: sanitizeSnapshotField(memory.updatedAt, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    tags: memory.tags.map(sanitizeSnapshotTag),
  })), null, 2);
}

function normalizeRelevantProfileItemSnapshots(items: readonly MateMemoryGenerationRelevantProfileItem[] = []): string {
  if (items.length === 0) {
    return "(関連 Profile Item snapshot はありません)";
  }

  return JSON.stringify(items.map((item) => ({
    id: sanitizeSnapshotId(item.id),
    sectionKey: sanitizeSnapshotField(item.sectionKey, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    category: sanitizeSnapshotField(item.category, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    claimKey: sanitizeSnapshotField(item.claimKey, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    renderedText: sanitizeSnapshotField(item.renderedText, SNAPSHOT_TEXT_MAX_LENGTH),
    salienceScore: item.salienceScore,
    updatedAt: sanitizeSnapshotField(item.updatedAt, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    tags: item.tags.map(sanitizeSnapshotTag),
  })), null, 2);
}

function normalizeForgottenTombstoneSnapshots(tombstones: readonly MateMemoryGenerationForgottenTombstone[] = []): string {
  if (tombstones.length === 0) {
    return "(忘却 tombstone snapshot はありません)";
  }

  return JSON.stringify(tombstones.map((tombstone) => ({
    id: sanitizeSnapshotId(tombstone.id),
    digestKind: sanitizeSnapshotField(tombstone.digestKind, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    category: sanitizeSnapshotField(tombstone.category, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    sectionKey: sanitizeSnapshotField(tombstone.sectionKey, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
    projectDigestId: tombstone.projectDigestId === null
      ? null
      : sanitizeSnapshotId(tombstone.projectDigestId),
    sourceGrowthEventId: tombstone.sourceGrowthEventId === null
      ? null
      : sanitizeSnapshotId(tombstone.sourceGrowthEventId),
    sourceProfileItemId: tombstone.sourceProfileItemId === null
      ? null
      : sanitizeSnapshotId(tombstone.sourceProfileItemId),
    createdAt: sanitizeSnapshotField(tombstone.createdAt, SNAPSHOT_SHORT_TEXT_MAX_LENGTH),
  })), null, 2);
}

export function buildMateMemoryGenerationPrompt(input: MateMemoryGenerationPromptInput): MateMemoryGenerationPrompt {
  const sourceType = normalizeText(input.sourceDefaults?.sourceType) || "session";
  const sourceSessionId = normalizeText(input.sourceDefaults?.sourceSessionId) || "(未設定)";
  const sourceAuditLogId = input.sourceDefaults?.sourceAuditLogId ?? null;
  const projectDigestId = normalizeText(input.sourceDefaults?.projectDigestId) || "(未設定)";

  const systemText = [
    "あなたは WithMate の Mate Memory 生成器です。",
    "返答は JSON object のみを返してください。",
    "Markdown や説明文、コードフェンスは絶対に出さないでください。",
    "schema-valid な memories がある場合は、機密判定と forgotten tombstone 一致を除いて全件返してください。",
    "機密情報 (シークレット, パスワード, API トークン, 認証キー, クレジットカード, 個人番号 等) を必ず出力しないでください。",
    "既存 tag catalog は type と tagValueNormalized で照合し、一致する場合はその catalog の tagType/tagValue を tags[] に入れてください。完全一致がない場合のみ newTags[] へ type/value/reason を提案してください。",
    "tags は同一 type/value を重複して返さないでください。",
    "remember は true の時のみ記憶保持を強化し、他は false を使う。",
  ].join("\n");

  const userText = [
    "# Mate",
    `name: ${normalizeText(input.mateName) || "(未設定)"}`,
    `summary: ${normalizeText(input.mateSummary) || "(未設定)"}`,
    "",
    "# Source defaults",
    `sourceType: ${sourceType}`,
    `sourceSessionId: ${sourceSessionId}`,
    `sourceAuditLogId: ${sourceAuditLogId}`,
    `projectDigestId: ${projectDigestId}`,
    "",
    "# Existing tag catalog",
    renderTagCatalog(input.existingTagCatalog),
    "",
    "# Relevant memories",
    normalizeRelevantMemorySnapshots(input.relevantMemories),
    "",
    "# Relevant profile items",
    normalizeRelevantProfileItemSnapshots(input.relevantProfileItems),
    "",
    "# Forgotten tombstones",
    normalizeForgottenTombstoneSnapshots(input.forgottenTombstones),
    "",
    "# Recent conversation",
    normalizeText(input.recentConversationText) || "(会話テキストなし)",
    "",
    "# Output Rules",
    "- schema として memories 配列を必ず返す",
    "- memories 内部の必須フィールドは省略しない",
    "- schema に必要な field は必ず指定し、自然言語での説明を混在させない",
    "- Relevant memories の statement と Relevant profile items の renderedText は preview（短い抜粋）です。元 transcript の完全な本文は含まれていません。",
    "- 余計な前置き・結論や注釈は返さない",
    "- relation は new / reinforces / updates / contradicts のいずれかを返す",
    "- relation が new 以外なら targetClaimKey を指定する",
    "- relation の参照先の補助情報がある場合は relatedRefs / supersedesRefs を配列で返す",
    "- relatedRefs / supersedesRefs の id は prompt に提示された関連 Memory / Profile Item の ID をそのままコピーして使う",
    "- 参照できる exact ID がない場合は relatedRefs / supersedesRefs を空配列にする",
    "- Memory 参照は { \"type\": \"memory\", \"id\": \"...\" }、Profile Item 参照は { \"type\": \"profile_item\", \"id\": \"...\" } で返す",
    "- 文字列 ID 形式は Memory 参照だけの後方互換形式なので、Profile Item 参照には使わない",
    "- 既存 catalog に無いタグ追加が必要なら newTags へ type/value/reason を入れ、無い場合は空配列にする",
    "- 既存 catalog は type と tagValueNormalized の完全一致で評価し、一致した catalog の tagType/tagValue を tags に使う",
    "- 既存 catalog に該当がなければ tags へ混ぜず newTags を使う",
    "- forgotten tombstone metadata と同じ内容と判断できる記憶は memories に含めない",
    "",
    "# Output JSON shape",
    '{"memories":[{"statement":"...","growthSourceType":"assistant_inference","kind":"observation","targetSection":"core","confidence":80,"salienceScore":70,"tags":[{"type":"Topic","value":"focus"}],"relation":"updates","relatedRefs":[{"type":"memory","id":"memory-event-id-1"},{"type":"profile_item","id":"profile-item-id-1"}],"supersedesRefs":[{"type":"memory","id":"memory-event-id-old"}],"targetClaimKey":"reply_length","newTags":[{"type":"Focus","value":"timing","reason":"既存 catalog になかったため"}],"remember":false,"sourceType":"mate_talk","sourceSessionId":null,"sourceAuditLogId":null,"projectDigestId":null}]}',
  ].join("\n");

  return {
    systemText,
    userText,
    outputSchema: MATE_MEMORY_GENERATION_OUTPUT_SCHEMA,
  };
}

export function buildMateMemoryGenerationLogicalPrompt(
  prompt: MateMemoryGenerationPrompt,
): AuditLogicalPrompt {
  return {
    systemText: prompt.systemText,
    inputText: prompt.userText,
    composedText: `${prompt.systemText}\n\n${prompt.userText}`.trim(),
  };
}

export function buildMateMemoryGenerationTransportPayload(
  provider: string,
  settings: MateMemoryGenerationResolvedSettings,
  metadata?: MateMemoryGenerationPromptInput["sourceDefaults"],
): AuditTransportPayload {
  const fields: AuditTransportPayload["fields"] = [
    { label: "provider", value: provider },
    { label: "model", value: settings.model },
    { label: "reasoningEffort", value: settings.reasoningEffort },
    { label: "timeoutSeconds", value: String(settings.timeoutSeconds) },
  ];

  if (metadata?.sourceType != null) {
    fields.push({ label: "sourceType", value: metadata.sourceType });
  }
  if (metadata?.sourceSessionId != null) {
    fields.push({ label: "sourceSessionId", value: metadata.sourceSessionId });
  }
  if (metadata?.sourceAuditLogId != null) {
    fields.push({ label: "sourceAuditLogId", value: String(metadata.sourceAuditLogId) });
  }
  if (metadata?.projectDigestId != null) {
    fields.push({ label: "projectDigestId", value: metadata.projectDigestId });
  }

  return {
    summary: "Mate memory generation payload",
    fields,
  };
}
