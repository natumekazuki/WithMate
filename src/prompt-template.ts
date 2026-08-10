export const PROMPT_TEMPLATE_NAME_MAX_LENGTH = 120;
export const PROMPT_TEMPLATE_PROMPT_MAX_BYTES = 256 * 1024;

export type PromptTemplate = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreatePromptTemplateInput = {
  name: string;
  prompt: string;
};

export type UpdatePromptTemplateInput = CreatePromptTemplateInput & {
  id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePromptTemplateName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("テンプレート名は文字列で指定してください。");
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("テンプレート名を入力してください。");
  }
  if (normalized.length > PROMPT_TEMPLATE_NAME_MAX_LENGTH) {
    throw new Error(`テンプレート名は${PROMPT_TEMPLATE_NAME_MAX_LENGTH}文字以内で入力してください。`);
  }
  return normalized;
}

export function normalizePromptTemplatePrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("プロンプト本文は文字列で指定してください。");
  }
  if (!value.trim()) {
    throw new Error("プロンプト本文を入力してください。");
  }
  if (new TextEncoder().encode(value).byteLength > PROMPT_TEMPLATE_PROMPT_MAX_BYTES) {
    throw new Error("プロンプト本文は256 KiB以内で入力してください。");
  }
  return value;
}

export function normalizePromptTemplateId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError("テンプレートIDが不正です。");
  }
  return value;
}

export function parseCreatePromptTemplateInput(value: unknown): CreatePromptTemplateInput {
  if (!isRecord(value)) {
    throw new TypeError("テンプレートの作成内容が不正です。");
  }
  return {
    name: normalizePromptTemplateName(value.name),
    prompt: normalizePromptTemplatePrompt(value.prompt),
  };
}

export function parseUpdatePromptTemplateInput(value: unknown): UpdatePromptTemplateInput {
  if (!isRecord(value)) {
    throw new TypeError("テンプレートの更新内容が不正です。");
  }
  return {
    id: normalizePromptTemplateId(value.id),
    name: normalizePromptTemplateName(value.name),
    prompt: normalizePromptTemplatePrompt(value.prompt),
  };
}
