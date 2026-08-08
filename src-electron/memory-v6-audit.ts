import type {
  MemoryAuditCandidate,
  MemoryTargetAudit,
  MemoryTargetInventoryItem,
} from "../src/memory-v6/memory-response-contract.js";
import type { MemoryEntryDetail } from "../src/memory-v6/memory-state.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import type { MemoryV6TagStatistic } from "./memory-v6-storage.js";

function auditCandidate(entry: MemoryEntryDetail, reasons: string[]): MemoryAuditCandidate {
  return {
    id: entry.id,
    title: entry.title,
    preview: entry.preview,
    updatedAt: entry.updatedAt,
    reasons,
  };
}

function normalizedAuditTitle(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

export function buildMemoryTargetAudit(input: {
  target: MemoryTargetInventoryItem;
  resolvedTarget: MemoryV6ResolvedTarget;
  entries: readonly MemoryEntryDetail[];
  tagStatistics: readonly MemoryV6TagStatistic[];
  staleBefore: string;
}): MemoryTargetAudit {
  const countsByKind: MemoryTargetAudit["countsByKind"] = {};
  const titleGroups = new Map<string, MemoryEntryDetail[]>();
  const staleOrProgressCandidates: MemoryAuditCandidate[] = [];
  const wrongScopeCandidates: MemoryAuditCandidate[] = [];
  const documentationCandidates: MemoryAuditCandidate[] = [];
  const suspiciousTagCandidates: MemoryAuditCandidate[] = [];
  const progressPattern = /(in progress|progress|opened|completed|next\b|作業中|進行中|完了|次は|次:|途中)/i;
  const globalPattern = /(all projects|cross-project|global|provider-wide|cli-wide|全プロジェクト|プロジェクト共通|全体共通|グローバル)/i;

  for (const entry of input.entries) {
    countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
    const titleKey = normalizedAuditTitle(entry.title);
    if (titleKey) {
      titleGroups.set(titleKey, [...(titleGroups.get(titleKey) ?? []), entry]);
    }

    const stale = entry.updatedAt <= input.staleBefore;
    const progressLike = entry.kind === "deferred" || progressPattern.test(`${entry.title} ${entry.preview}`);
    if (stale || progressLike) {
      staleOrProgressCandidates.push(auditCandidate(entry, [
        ...(stale ? ["updated_before_stale_threshold"] : []),
        ...(progressLike ? ["progress_like_metadata"] : []),
      ]));
    }
    if (input.resolvedTarget.scope.type !== "global" && globalPattern.test(`${entry.title} ${entry.preview}`)) {
      wrongScopeCandidates.push(auditCandidate(entry, ["broader_scope_language_in_scoped_target"]));
    }
    if (input.resolvedTarget.scope.type === "project" && ["decision", "constraint", "convention", "boundary"].includes(entry.kind)) {
      documentationCandidates.push(auditCandidate(entry, ["durable_project_contract_kind"]));
    }
    if (entry.tags.length === 0) {
      suspiciousTagCandidates.push(auditCandidate(entry, ["missing_tags"]));
    }
  }

  return {
    target: input.target,
    countsByKind,
    topTags: input.tagStatistics.slice(0, 10).map((tag) => ({
      type: tag.type,
      value: tag.value,
      entryCount: tag.entryCount,
      latestUpdatedAt: tag.latestUpdatedAt,
    })),
    staleOrProgressCandidates: staleOrProgressCandidates.slice(0, 50),
    wrongScopeCandidates: wrongScopeCandidates.slice(0, 50),
    duplicateTitleCandidates: [...titleGroups.entries()]
      .filter(([, group]) => group.length > 1)
      .slice(0, 50)
      .map(([normalizedTitle, group]) => ({
        normalizedTitle,
        entries: group.map((entry) => auditCandidate(entry, ["duplicate_normalized_title"])),
      })),
    documentationCandidates: documentationCandidates.slice(0, 50),
    suspiciousTagCandidates: suspiciousTagCandidates.slice(0, 50),
  };
}
