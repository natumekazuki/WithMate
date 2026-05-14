import type { MateGrowthEventInput } from "./mate-growth-storage.js";

type GrowthTargetSection = MateGrowthEventInput["targetSection"];

export type MateMemoryGenerationSectionCandidate = {
  sourceType?: string | null;
  growthSourceType?: string | null;
  targetSection?: string | null;
  statement?: string | null;
  targetClaimKey?: string | null;
};

const VALID_TARGET_SECTIONS: readonly GrowthTargetSection[] = ["bond", "work_style", "project_digest", "core", "none"];
const SELF_DEFINITION_CLAIM_KEYS = [
  "first_person",
  "self_definition",
  "self_identity",
  "identity",
  "persona",
  "personality",
  "self_recognition",
  "mate_core",
];
const SELF_DEFINITION_STATEMENT_PATTERNS = [
  /一人称/,
  /自己(?:定義|認識|紹介)/,
  /自分(?:自身)?(?:の)?(?:こと|存在|性格|人格|キャラクター)/,
  /(?:私は|わたしは|僕は|ぼくは|俺は|おれは).{0,40}(?:です|である|として|振る舞|名乗|呼ぶ)/,
  /(?:性格|人格|キャラクター).{0,40}(?:です|である|として|振る舞|設定|定義)/,
];

export function resolveMateMemoryGenerationTargetSection(
  candidate: MateMemoryGenerationSectionCandidate,
): GrowthTargetSection {
  const targetSection = isGrowthTargetSection(candidate.targetSection) ? candidate.targetSection : "none";
  if (targetSection === "none" || targetSection === "project_digest") {
    return targetSection;
  }
  if (isMateTalkSelfDefinitionCandidate(candidate)) {
    return "core";
  }
  return targetSection;
}

function isMateTalkSelfDefinitionCandidate(candidate: MateMemoryGenerationSectionCandidate): boolean {
  if (candidate.sourceType !== "mate_talk") {
    return false;
  }
  if (candidate.growthSourceType !== "explicit_user_instruction" && candidate.growthSourceType !== "user_correction") {
    return false;
  }
  return hasSelfDefinitionClaimKey(candidate.targetClaimKey) || hasSelfDefinitionStatement(candidate.statement);
}

function hasSelfDefinitionClaimKey(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) {
    return false;
  }
  return SELF_DEFINITION_CLAIM_KEYS.some((key) => normalized.includes(key));
}

function hasSelfDefinitionStatement(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    return false;
  }
  return SELF_DEFINITION_STATEMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isGrowthTargetSection(value: unknown): value is GrowthTargetSection {
  return typeof value === "string" && VALID_TARGET_SECTIONS.includes(value as GrowthTargetSection);
}
