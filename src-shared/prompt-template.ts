/** 空白を正規化した表示名の長さ上限。 */
export const PROMPT_TEMPLATE_NAME_MAX_LENGTH = 120;
/** 保存できるプロンプト本文のUTF-8バイト数の上限。 */
export const PROMPT_TEMPLATE_PROMPT_MAX_BYTES = 256 * 1024;

/** 挿入に使う保存済みプロンプトの本文・表示名・IDと、作成・更新日時。 */
export type PromptTemplate = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

/** 新しいテンプレートへ保存する表示名と本文。 */
export type CreatePromptTemplateInput = {
  name: string;
  prompt: string;
};

/** 更新するテンプレートのIDと、置き換える表示名・本文。 */
export type UpdatePromptTemplateInput = CreatePromptTemplateInput & {
  id: string;
};

/** 配列やnullを除き、名前・本文などのフィールドを読み取れるオブジェクトを選ぶ。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 名前の前後の空白を除き、連続する空白を一つに揃えてから空と上限超過を拒否する。 */
export function normalizePromptTemplateName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Template name must be a string.");
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Enter a template name.");
  }
  if (normalized.length > PROMPT_TEMPLATE_NAME_MAX_LENGTH) {
    throw new Error(
      `Template name must be ${PROMPT_TEMPLATE_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  return normalized;
}

/** 本文が空白だけでなく容量内なら、改行や前後の空白を含めて原文を返す。 */
export function normalizePromptTemplatePrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Prompt must be a string.");
  }
  if (!value.trim()) {
    throw new Error("Enter a prompt.");
  }
  if (
    new TextEncoder().encode(value).byteLength >
    PROMPT_TEMPLATE_PROMPT_MAX_BYTES
  ) {
    throw new Error("Prompt must be 256 KiB or less.");
  }
  return value;
}

/** 空白だけのIDと長すぎるIDを拒み、照合用の有効な文字列はそのまま返す。 */
export function normalizePromptTemplateId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError("Invalid template ID.");
  }
  return value;
}

/** 作成の入力から有効な表示名・本文だけを取り出し、保存用に揃える。 */
export function parseCreatePromptTemplateInput(
  value: unknown,
): CreatePromptTemplateInput {
  if (!isRecord(value)) {
    throw new TypeError("Invalid template creation input.");
  }
  return {
    name: normalizePromptTemplateName(value.name),
    prompt: normalizePromptTemplatePrompt(value.prompt),
  };
}

/** 更新対象のIDを検証し、作成と同じ規則で表示名・本文を読み取る。 */
export function parseUpdatePromptTemplateInput(
  value: unknown,
): UpdatePromptTemplateInput {
  if (!isRecord(value)) {
    throw new TypeError("Invalid template update input.");
  }
  return {
    id: normalizePromptTemplateId(value.id),
    name: normalizePromptTemplateName(value.name),
    prompt: normalizePromptTemplatePrompt(value.prompt),
  };
}
