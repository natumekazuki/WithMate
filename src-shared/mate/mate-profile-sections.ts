import type { MateProfileSectionState } from "./mate-state.js";

/** プロフィールとして扱う節のキー。プロジェクト要約は別のため含めない。 */
export type MateProfileRuntimeSectionKey = Exclude<
  MateProfileSectionState["sectionKey"],
  "project_digest"
>;

/** プロフィール各節の表示名と役割、常時のProvider指示に含めるかどうか。 */
export type MateProfileSectionRule = {
  sectionKey: MateProfileRuntimeSectionKey;
  title: string;
  role: string;
  providerInstructionIncluded: boolean;
};

/** Core・Bond・Work Style・Notesの順序と、Provider指示へ投影する境界。 */
export const MATE_PROFILE_SECTION_RULES: readonly MateProfileSectionRule[] = [
  {
    sectionKey: "core",
    title: "Core",
    role: "Mate の自己定義、人格の核、自己認識を保持する。",
    providerInstructionIncluded: true,
  },
  {
    sectionKey: "bond",
    title: "Bond",
    role: "ユーザーとの関係性、呼び方、距離感を保持する。",
    providerInstructionIncluded: true,
  },
  {
    sectionKey: "work_style",
    title: "Work Style",
    role: "作業時の振る舞い、説明方針、共同作業の進め方を保持する。",
    providerInstructionIncluded: true,
  },
  {
    sectionKey: "notes",
    title: "Notes",
    role: "補助的、非構造、長文のメモを保持する。常時適用する直接指示として扱わない。",
    providerInstructionIncluded: false,
  },
] as const;

/** 設定表示などで使う、規則と同じ順序のプロフィール節キー。 */
export const MATE_PROFILE_SECTION_KEYS = MATE_PROFILE_SECTION_RULES.map(
  (rule) => rule.sectionKey,
);

/** 直接指示にしないNotesを除いた、Provider向けの節キー。 */
export const PROVIDER_INSTRUCTION_PROFILE_SECTION_KEYS =
  MATE_PROFILE_SECTION_RULES.filter(
    (rule) => rule.providerInstructionIncluded,
  ).map((rule) => rule.sectionKey);

const MATE_PROFILE_SECTION_RULE_BY_KEY = new Map(
  MATE_PROFILE_SECTION_RULES.map((rule) => [rule.sectionKey, rule]),
);

/** 指定した節の規則を返す。未知のキーを別の節として扱わず例外にする。 */
export function getMateProfileSectionRule(
  sectionKey: MateProfileRuntimeSectionKey,
): MateProfileSectionRule {
  const rule = MATE_PROFILE_SECTION_RULE_BY_KEY.get(sectionKey);
  if (!rule) {
    throw new Error(
      `Mate profile section rule が見つからないよ: ${sectionKey}`,
    );
  }
  return rule;
}

/** Notesを含むプロフィール用の節が、共通規則に定義されているかを調べる。 */
export function isMateProfileRuntimeSectionKey(
  sectionKey: string,
): sectionKey is MateProfileRuntimeSectionKey {
  return MATE_PROFILE_SECTION_RULE_BY_KEY.has(
    sectionKey as MateProfileRuntimeSectionKey,
  );
}

/** 指定した節を常時のProvider指示に含めてよいか判定する。 */
export function isProviderInstructionProfileSectionKey(
  sectionKey: string,
): sectionKey is MateProfileRuntimeSectionKey {
  return (
    PROVIDER_INSTRUCTION_PROFILE_SECTION_KEYS as readonly string[]
  ).includes(sectionKey);
}
