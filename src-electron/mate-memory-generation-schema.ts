import type { MateGeneratedMemoryInput } from "./mate-memory-storage.js";

export type MateMemoryGenerationResponse = {
  memories: MateGeneratedMemoryInput[];
};

export type MateMemoryGenerationParseDefaults = {
  sourceType?: string | null;
  sourceSessionId?: string | null;
  sourceAuditLogId?: number | null;
  projectDigestId?: string | null;
};

const SOURCE_TYPES = ["session", "companion", "manual", "system"] as const;
const GROWTH_SOURCE_TYPES = [
  "explicit_user_instruction",
  "user_correction",
  "repeated_user_behavior",
  "assistant_inference",
  "tool_or_file_observation",
] as const;
const MEMORY_KINDS = [
  "conversation",
  "preference",
  "relationship",
  "work_style",
  "boundary",
  "project_context",
  "curiosity",
  "observation",
  "correction",
] as const;
const TARGET_SECTIONS = ["bond", "work_style", "project_digest", "core", "none"] as const;

type GrowthSourceType = (typeof GROWTH_SOURCE_TYPES)[number];
type MemoryKind = (typeof MEMORY_KINDS)[number];
type TargetSection = (typeof TARGET_SECTIONS)[number];

type ParsedOptions = Required<Pick<MateMemoryGenerationParseDefaults, "sourceType">> & Omit<MateMemoryGenerationParseDefaults, "sourceType">;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memories を含む object で受け取るよ。");
  }
  return value as Record<string, unknown>;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toOptionalText(value: unknown): string | undefined {
  const normalized = toText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function requireText(value: unknown, field: string): string {
  const normalized = toText(value);
  if (!normalized) {
    throw new Error(`${field} が必要だよ。`);
  }
  return normalized;
}

function assertOneOf<T extends string>(
  value: unknown,
  candidates: readonly T[],
  field: string,
): T {
  if (typeof value === "string" && (candidates as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${field} が不正だよ。`);
}

function parsePercent(value: unknown, field: string): number {
  const normalized = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : Number.NaN;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${field} が 0-100 の整数でないよ。`);
  }
  return normalized;
}

function parseOptionalAuditLogId(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("sourceAuditLogId が不正だよ。");
  }
  return Math.floor(value);
}

function parseTags(value: unknown): Array<{ type: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Array<{ type: string; value: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const type = toText((item as { type?: unknown }).type);
    const val = toText((item as { value?: unknown }).value);
    if (!type || !val) {
      continue;
    }
    result.push({ type, value: val });
  }
  return result;
}

function parseMemory(
  memoryValue: unknown,
  defaults: ParsedOptions,
): MateGeneratedMemoryInput {
  const memory = asObject(memoryValue);

  const sourceType = memory.sourceType !== undefined
    ? assertOneOf(memory.sourceType, SOURCE_TYPES, "sourceType")
    : assertOneOf(defaults.sourceType, SOURCE_TYPES, "sourceType");

  return {
    sourceType,
    sourceSessionId: toOptionalText(memory.sourceSessionId) ?? toOptionalText(defaults.sourceSessionId),
    sourceAuditLogId: parseOptionalAuditLogId(
      memory.sourceAuditLogId ?? defaults.sourceAuditLogId,
    ),
    projectDigestId: toOptionalText(memory.projectDigestId) ?? toOptionalText(defaults.projectDigestId),
    growthSourceType: assertOneOf(memory.growthSourceType, GROWTH_SOURCE_TYPES, "growthSourceType") as GrowthSourceType,
    kind: assertOneOf(memory.kind, MEMORY_KINDS, "kind") as MemoryKind,
    targetSection: assertOneOf(memory.targetSection, TARGET_SECTIONS, "targetSection") as TargetSection,
    statement: requireText(memory.statement, "statement"),
    confidence: parsePercent(memory.confidence, "confidence"),
    salienceScore: parsePercent(memory.salienceScore, "salienceScore"),
    tags: parseTags(memory.tags),
    retention: (memory.remember === true || memory.forceRemember === true || memory.retention === "force") ? "force" : undefined,
  };
}

function readSourceDefaults(root: Record<string, unknown>, explicitDefaults: MateMemoryGenerationParseDefaults): ParsedOptions {
  const sourceType = explicitDefaults.sourceType ?? toOptionalText(root.sourceType);
  return {
    sourceType: sourceType ?? null,
    sourceSessionId: explicitDefaults.sourceSessionId ?? toOptionalText(root.sourceSessionId) ?? null,
    sourceAuditLogId: explicitDefaults.sourceAuditLogId ?? (root.sourceAuditLogId as number | undefined | null) ?? null,
    projectDigestId: explicitDefaults.projectDigestId ?? toOptionalText(root.projectDigestId) ?? null,
  };
}

export function parseMateMemoryGenerationResponse(
  value: unknown,
  defaults: MateMemoryGenerationParseDefaults = {},
): MateMemoryGenerationResponse {
  const root = asObject(value);

  if (!Array.isArray(root.memories)) {
    throw new Error("memories 配列が必要だよ。");
  }

  const parsedDefaults = readSourceDefaults(root, defaults);
  const memories = root.memories.map((memory) => parseMemory(memory, parsedDefaults));

  return { memories };
}
