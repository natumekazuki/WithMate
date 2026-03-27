import type { ProjectMemoryCategory, ProjectMemoryEntry, Session, SessionMemoryDelta } from "../src/app-state.js";

type PromotableProjectMemoryEntry = Omit<ProjectMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt">;

type TaggedNoteResolution = {
  category: ProjectMemoryCategory;
  detail: string;
};

const TAGGED_NOTE_PREFIXES: Array<{
  category: ProjectMemoryCategory;
  prefixes: string[];
}> = [
  { category: "constraint", prefixes: ["constraint:", "constraint：", "制約:", "制約："] },
  { category: "convention", prefixes: ["convention:", "convention：", "慣例:", "慣例："] },
  { category: "context", prefixes: ["context:", "context：", "文脈:", "文脈：", "背景:", "背景："] },
  { category: "deferred", prefixes: ["deferred:", "deferred：", "保留:", "保留：", "見送り:", "見送り："] },
];

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildTitle(detail: string): string {
  const normalized = normalizeLine(detail);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= 72) {
    return normalized;
  }

  return `${normalized.slice(0, 69).trimEnd()}...`;
}

function extractKeywords(text: string): string[] {
  const tokens = text.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const unique = new Set<string>();
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (!normalized) {
      continue;
    }

    unique.add(normalized);
    if (unique.size >= 8) {
      break;
    }
  }

  return [...unique];
}

function resolveTaggedNote(note: string): TaggedNoteResolution | null {
  const trimmed = note.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  for (const candidate of TAGGED_NOTE_PREFIXES) {
    for (const prefix of candidate.prefixes) {
      if (!lower.startsWith(prefix.toLowerCase())) {
        continue;
      }

      const detail = normalizeLine(trimmed.slice(prefix.length));
      if (!detail) {
        return null;
      }

      return {
        category: candidate.category,
        detail,
      };
    }
  }

  return null;
}

function makeEntry(
  projectScopeId: string,
  sourceSessionId: string,
  category: ProjectMemoryCategory,
  detail: string,
): PromotableProjectMemoryEntry | null {
  const normalizedDetail = normalizeLine(detail);
  const title = buildTitle(normalizedDetail);
  if (!normalizedDetail || !title) {
    return null;
  }

  return {
    projectScopeId,
    sourceSessionId,
    category,
    title,
    detail: normalizedDetail,
    keywords: extractKeywords(`${title} ${normalizedDetail}`),
    evidence: [],
  };
}

export function buildProjectMemoryPromotionEntries(
  session: Pick<Session, "id">,
  projectScopeId: string,
  delta: SessionMemoryDelta,
): PromotableProjectMemoryEntry[] {
  const entries: PromotableProjectMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const decision of delta.decisions ?? []) {
    const entry = makeEntry(projectScopeId, session.id, "decision", decision);
    if (!entry) {
      continue;
    }

    const key = `${entry.category}\n${entry.title}\n${entry.detail}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push(entry);
  }

  for (const note of delta.notes ?? []) {
    const resolved = resolveTaggedNote(note);
    if (!resolved) {
      continue;
    }

    const entry = makeEntry(projectScopeId, session.id, resolved.category, resolved.detail);
    if (!entry) {
      continue;
    }

    const key = `${entry.category}\n${entry.title}\n${entry.detail}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push(entry);
  }

  return entries;
}
