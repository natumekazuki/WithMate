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
};

export type MateMemoryGenerationPromptInput = {
  recentConversationText: string;
  existingTagCatalog: readonly TagCatalogEntry[];
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

function renderTagCatalog(entries: readonly TagCatalogEntry[]): string {
  if (entries.length === 0) {
    return "(既存 tag catalog はありません)";
  }

  const uniq = new Set<string>();
  const lines: string[] = [];

  for (const entry of entries) {
    const type = normalizeText(entry.tagType);
    const value = normalizeText(entry.tagValue);
    if (!type || !value) {
      continue;
    }

    const key = `${type.toLowerCase()}\u0000${value.toLowerCase()}`;
    if (uniq.has(key)) {
      continue;
    }

    uniq.add(key);
    lines.push(`- ${type}: ${value}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(既存 tag catalog はありません)";
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
    "schema-valid な memories がある場合は、機密判定以外で除外せず全件返してください。",
    "機密情報 (シークレット, パスワード, API トークン, 認証キー, クレジットカード, 個人番号 等) を必ず出力しないでください。",
    "tags は既存 tag catalog を優先して選択し、適切な一致がない場合のみ新規タグを作成してください。",
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
    "# Recent conversation",
    normalizeText(input.recentConversationText) || "(会話テキストなし)",
    "",
    "# Output Rules",
    "- schema として memories 配列を必ず返す",
    "- memories 内部の必須フィールドは省略しない",
    "- schema に必要な field は必ず指定し、自然言語での説明を混在させない",
    "- 余計な前置き・結論や注釈は返さない",
    "",
    "# Output JSON shape",
    '{"memories":[{"statement":"...","growthSourceType":"assistant_inference","kind":"observation","targetSection":"core","confidence":80,"salienceScore":70,"tags":[{"type":"Topic","value":"focus"}],"remember":false,"sourceType":"mate_talk","sourceSessionId":null,"sourceAuditLogId":null,"projectDigestId":null}]}',
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
