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
    throw new TypeError("Template name must be a string.");
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Enter a template name.");
  }
  if (normalized.length > PROMPT_TEMPLATE_NAME_MAX_LENGTH) {
    throw new Error(`Template name must be ${PROMPT_TEMPLATE_NAME_MAX_LENGTH} characters or fewer.`);
  }
  return normalized;
}

export function normalizePromptTemplatePrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Prompt must be a string.");
  }
  if (!value.trim()) {
    throw new Error("Enter a prompt.");
  }
  if (new TextEncoder().encode(value).byteLength > PROMPT_TEMPLATE_PROMPT_MAX_BYTES) {
    throw new Error("Prompt must be 256 KiB or less.");
  }
  return value;
}

export function normalizePromptTemplateId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError("Invalid template ID.");
  }
  return value;
}

export function parseCreatePromptTemplateInput(value: unknown): CreatePromptTemplateInput {
  if (!isRecord(value)) {
    throw new TypeError("Invalid template creation input.");
  }
  return {
    name: normalizePromptTemplateName(value.name),
    prompt: normalizePromptTemplatePrompt(value.prompt),
  };
}

export function parseUpdatePromptTemplateInput(value: unknown): UpdatePromptTemplateInput {
  if (!isRecord(value)) {
    throw new TypeError("Invalid template update input.");
  }
  return {
    id: normalizePromptTemplateId(value.id),
    name: normalizePromptTemplateName(value.name),
    prompt: normalizePromptTemplatePrompt(value.prompt),
  };
}
