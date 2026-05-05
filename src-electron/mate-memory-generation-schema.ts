import type { MateGeneratedMemoryInput } from "./mate-memory-storage.js";

export type MateMemoryGenerationResponse = {
  memories: MateGeneratedMemoryInput[];
};

export type MemoryRef = {
  type: "memory" | "profile_item";
  id: string;
};

export type MateMemoryGenerationParseDefaults = {
  sourceType?: string | null;
  sourceSessionId?: string | null;
  sourceAuditLogId?: number | null;
  projectDigestId?: string | null;
  existingTagCatalog?: readonly {
    tagType: string;
    tagValue: string;
    tagValueNormalized?: string | null;
  }[];
};

const SOURCE_TYPES = ["session", "companion", "manual", "system", "mate_talk"] as const;
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
const RELATION_TYPES = ["new", "reinforces", "updates", "contradicts"] as const;
const MEMORY_REF_TYPES = ["memory", "profile_item"] as const;

type GrowthSourceType = (typeof GROWTH_SOURCE_TYPES)[number];
type MemoryKind = (typeof MEMORY_KINDS)[number];
type TargetSection = (typeof TARGET_SECTIONS)[number];
type RelationType = (typeof RELATION_TYPES)[number];

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

function normalizeTagValue(value: string): string {
  return value.trim().toLowerCase();
}

function makeTagKey(type: string, value: string): string {
  return `${normalizeTagValue(type)}\u0000${normalizeTagValue(value)}`;
}

type TagCatalogLookup = Map<string, {
  tagType: string;
  tagValue: string;
}>;

function setTagCatalogLookup(
  lookup: TagCatalogLookup,
  key: string,
  value: { tagType: string; tagValue: string },
): void {
  if (!lookup.has(key)) {
    lookup.set(key, value);
  }
}

function buildTagCatalogLookup(
  entries: readonly {
    tagType: string;
    tagValue: string;
    tagValueNormalized?: string | null;
  }[],
): TagCatalogLookup {
  const lookup = new Map<string, { tagType: string; tagValue: string }>();
  for (const entry of entries) {
    const type = toText(entry.tagType);
    const normalizedType = normalizeTagValue(type);
    const value = toText(entry.tagValue);
    const normalizedValue = normalizeTagValue(toOptionalText(entry.tagValueNormalized) ?? value);

    if (!type || !normalizedType || !normalizedValue || !value) {
      continue;
    }

    const catalogValue = {
      tagType: type,
      tagValue: value,
    };
    setTagCatalogLookup(lookup, `${normalizedType}\u0000${normalizedValue}`, catalogValue);
    setTagCatalogLookup(lookup, makeTagKey(type, value), catalogValue);
  }
  return lookup;
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

function parseTags(value: unknown, catalog: TagCatalogLookup): Array<{ type: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Array<{ type: string; value: string }> = [];
  const hasCatalog = catalog.size > 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const type = toText((item as { type?: unknown }).type);
    const val = toText((item as { value?: unknown }).value);
    if (!type || !val) {
      continue;
    }

    const match = catalog.get(makeTagKey(type, val));
    if (match) {
      result.push({ type: match.tagType, value: match.tagValue });
      continue;
    }
    if (!hasCatalog) {
      result.push({ type, value: val });
    }
  }
  return result;
}

function parseTagsWithCatalog(
  value: unknown,
  catalog: TagCatalogLookup,
): {
  tags: Array<{ type: string; value: string }>;
  convertedNewTags: Array<{ type: string; value: string; reason: string }>;
} {
  if (catalog.size === 0) {
    return {
      tags: parseTags(value, catalog),
      convertedNewTags: [],
    };
  }

  if (!Array.isArray(value)) {
    return { tags: [], convertedNewTags: [] };
  }

  const tags: Array<{ type: string; value: string }> = [];
  const convertedNewTags: Array<{ type: string; value: string; reason: string }> = [];
  const convertedSet = new Set<string>();
  const acceptedSet = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const type = toText((item as { type?: unknown }).type);
    const val = toText((item as { value?: unknown }).value);
    if (!type || !val) {
      continue;
    }

    const match = catalog.get(makeTagKey(type, val));
    if (match) {
      const acceptedKey = makeTagKey(match.tagType, match.tagValue);
      if (!acceptedSet.has(acceptedKey)) {
        acceptedSet.add(acceptedKey);
        tags.push({ type: match.tagType, value: match.tagValue });
      }
      continue;
    }

    const key = makeTagKey(type, val);
    if (convertedSet.has(key)) {
      continue;
    }
    convertedSet.add(key);
    convertedNewTags.push({
      type,
      value: val,
      reason: "既存 catalog に一致しなかったため",
    });
  }

  return { tags, convertedNewTags };
}

function mergeTagsWithNewTags(
  existingNewTags: Array<{ type: string; value: string; reason: string }>,
  convertedNewTags: Array<{ type: string; value: string; reason: string }>,
): Array<{ type: string; value: string; reason: string }> {
  if (convertedNewTags.length === 0) {
    return existingNewTags;
  }

  const merged = [...existingNewTags];
  const seen = new Set<string>();
  for (const tag of existingNewTags) {
    seen.add(makeTagKey(tag.type, tag.value));
  }
  for (const tag of convertedNewTags) {
    const key = makeTagKey(tag.type, tag.value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(tag);
  }
  return merged;
}

function mergeAcceptedTags(
  left: Array<{ type: string; value: string }>,
  right: Array<{ type: string; value: string }>,
): Array<{ type: string; value: string }> {
  if (right.length === 0) {
    return left;
  }

  const merged = [...left];
  const seen = new Set(left.map((tag) => makeTagKey(tag.type, tag.value)));
  for (const tag of right) {
    const key = makeTagKey(tag.type, tag.value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(tag);
  }
  return merged;
}

function parseTagCandidates(value: unknown, field: string): Array<{ type: string; value: string; reason: string }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} が不正だよ。`);
  }
  const result: Array<{ type: string; value: string; reason: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field} が不正だよ。`);
    }
    const type = toText((item as { type?: unknown }).type);
    const val = toText((item as { value?: unknown }).value);
    const reason = toText((item as { reason?: unknown }).reason);
    if (!type || !val || !reason) {
      throw new Error(`${field} が不正だよ。`);
    }
    result.push({ type, value: val, reason });
  }
  return result;
}

function splitNewTagsByCatalog(
  newTags: Array<{ type: string; value: string; reason: string }>,
  catalog: TagCatalogLookup,
): {
  acceptedTags: Array<{ type: string; value: string }>;
  newTags: Array<{ type: string; value: string; reason: string }>;
} {
  if (catalog.size === 0) {
    return {
      acceptedTags: [],
      newTags,
    };
  }

  const acceptedTags: Array<{ type: string; value: string }> = [];
  const remainingNewTags: Array<{ type: string; value: string; reason: string }> = [];
  const acceptedSeen = new Set<string>();
  const newSeen = new Set<string>();

  for (const tag of newTags) {
    const match = catalog.get(makeTagKey(tag.type, tag.value));
    if (match) {
      const acceptedKey = makeTagKey(match.tagType, match.tagValue);
      if (!acceptedSeen.has(acceptedKey)) {
        acceptedSeen.add(acceptedKey);
        acceptedTags.push({ type: match.tagType, value: match.tagValue });
      }
      continue;
    }

    const newKey = makeTagKey(tag.type, tag.value);
    if (newSeen.has(newKey)) {
      continue;
    }
    newSeen.add(newKey);
    remainingNewTags.push(tag);
  }

  return {
    acceptedTags,
    newTags: remainingNewTags,
  };
}

function parseMemoryRef(value: unknown, field: string): MemoryRef | undefined {
  if (typeof value === "string") {
    const id = toText(value);
    if (!id) {
      return undefined;
    }
    return {
      type: "memory",
      id,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} が不正だよ。`);
  }

  const type = toText((value as { type?: unknown }).type);
  const id = toText((value as { id?: unknown }).id);
  if (!id || !MEMORY_REF_TYPES.includes(type as (typeof MEMORY_REF_TYPES)[number])) {
    throw new Error(`${field} が不正だよ。`);
  }

  return {
    type: type as MemoryRef["type"],
    id,
  };
}

function parseMemoryRefList(value: unknown, field: string): MemoryRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} が不正だよ。`);
  }

  const refs: MemoryRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const ref = parseMemoryRef(item, field);
    if (!ref) {
      continue;
    }
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }

  return refs;
}

function parseMemory(
  memoryValue: unknown,
  defaults: ParsedOptions,
): MateGeneratedMemoryInput {
  const memory = asObject(memoryValue);

  const sourceType = memory.sourceType !== undefined
    ? assertOneOf(memory.sourceType, SOURCE_TYPES, "sourceType")
    : assertOneOf(defaults.sourceType, SOURCE_TYPES, "sourceType");

  const relation = memory.relation !== undefined
    ? assertOneOf(memory.relation, RELATION_TYPES, "relation") as RelationType
    : undefined;
  const targetClaimKey = toOptionalText(memory.targetClaimKey);

  const hasRelatedRefs = memory.relatedRefs !== undefined;
  const hasSupersedesRefs = memory.supersedesRefs !== undefined;
  const relatedRefs = hasRelatedRefs ? parseMemoryRefList(memory.relatedRefs, "relatedRefs") : undefined;
  const supersedesRefs = hasSupersedesRefs ? parseMemoryRefList(memory.supersedesRefs, "supersedesRefs") : undefined;
  const catalog = defaults.existingTagCatalog
    ? buildTagCatalogLookup(defaults.existingTagCatalog)
    : new Map<string, { tagType: string; tagValue: string }>();
  const parsedNewTags = parseTagCandidates(memory.newTags, "newTags");
  const { tags: parsedTags, convertedNewTags } = parseTagsWithCatalog(memory.tags, catalog);
  const {
    acceptedTags: acceptedTagsFromNewTags,
    newTags: unmatchedNewTags,
  } = splitNewTagsByCatalog(parsedNewTags, catalog);
  const tags = mergeAcceptedTags(parsedTags, acceptedTagsFromNewTags);
  const newTags = mergeTagsWithNewTags(
    unmatchedNewTags,
    convertedNewTags,
  );

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
    relation,
    ...(relatedRefs !== undefined ? { relatedRefs } : {}),
    ...(supersedesRefs !== undefined ? { supersedesRefs } : {}),
    newTags,
    targetClaimKey,
    tags,
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
    ...(explicitDefaults.existingTagCatalog ? { existingTagCatalog: explicitDefaults.existingTagCatalog } : {}),
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
