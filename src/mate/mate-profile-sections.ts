import type { MateProfileSectionState } from "./mate-state.js";

export type MateProfileRuntimeSectionKey = Exclude<MateProfileSectionState["sectionKey"], "project_digest">;

export type MateProfileSectionRule = {
  sectionKey: MateProfileRuntimeSectionKey;
  title: string;
  role: string;
  mateTalkIncluded: boolean;
  providerInstructionIncluded: boolean;
};

export const MATE_PROFILE_SECTION_RULES: readonly MateProfileSectionRule[] = [
  {
    sectionKey: "core",
    title: "Core",
    role: "Mate の自己定義、人格の核、自己認識を保持する。",
    mateTalkIncluded: true,
    providerInstructionIncluded: true,
  },
  {
    sectionKey: "bond",
    title: "Bond",
    role: "ユーザーとの関係性、呼び方、距離感を保持する。",
    mateTalkIncluded: true,
    providerInstructionIncluded: true,
  },
  {
    sectionKey: "work_style",
    title: "Work Style",
    role: "作業時の振る舞い、説明方針、共同作業の進め方を保持する。",
    mateTalkIncluded: true,
    providerInstructionIncluded: true,
  },
  {
    sectionKey: "notes",
    title: "Notes",
    role: "補助的、非構造、長文のメモを保持する。常時適用する直接指示として扱わない。",
    mateTalkIncluded: true,
    providerInstructionIncluded: false,
  },
] as const;

export const MATE_PROFILE_SECTION_KEYS = MATE_PROFILE_SECTION_RULES.map((rule) => rule.sectionKey);

export const MATE_TALK_PROFILE_SECTION_KEYS = MATE_PROFILE_SECTION_RULES
  .filter((rule) => rule.mateTalkIncluded)
  .map((rule) => rule.sectionKey);

export const PROVIDER_INSTRUCTION_PROFILE_SECTION_KEYS = MATE_PROFILE_SECTION_RULES
  .filter((rule) => rule.providerInstructionIncluded)
  .map((rule) => rule.sectionKey);

const MATE_PROFILE_SECTION_RULE_BY_KEY = new Map(
  MATE_PROFILE_SECTION_RULES.map((rule) => [rule.sectionKey, rule]),
);

export function getMateProfileSectionRule(sectionKey: MateProfileRuntimeSectionKey): MateProfileSectionRule {
  const rule = MATE_PROFILE_SECTION_RULE_BY_KEY.get(sectionKey);
  if (!rule) {
    throw new Error(`Mate profile section rule が見つからないよ: ${sectionKey}`);
  }
  return rule;
}

export function isMateProfileRuntimeSectionKey(sectionKey: string): sectionKey is MateProfileRuntimeSectionKey {
  return MATE_PROFILE_SECTION_RULE_BY_KEY.has(sectionKey as MateProfileRuntimeSectionKey);
}

export function isMateTalkProfileSectionKey(sectionKey: string): sectionKey is MateProfileRuntimeSectionKey {
  return (MATE_TALK_PROFILE_SECTION_KEYS as readonly string[]).includes(sectionKey);
}

export function isProviderInstructionProfileSectionKey(
  sectionKey: string,
): sectionKey is MateProfileRuntimeSectionKey {
  return (PROVIDER_INSTRUCTION_PROFILE_SECTION_KEYS as readonly string[]).includes(sectionKey);
}
