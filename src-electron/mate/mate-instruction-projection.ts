import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import { isProviderInstructionProfileSectionKey } from "../../src-shared/mate/mate-profile-sections.js";
import { upsertManagedBlock } from "../skills/managed-instruction-block.js";

/** 既存の指示文から Mate プロフィールの管理ブロックを特定する固定 ID。 */
export const MATE_PROFILE_BLOCK_ID = "mate-profile";

/** Provider 向けの指示文に投影できるプロフィール区分。 */
export type MateInstructionProfileSectionKey = "core" | "bond" | "work_style";

/** プロフィール区分に対応して呼び出し元から渡される投影済み本文。 */
export type MateInstructionSectionContent = {
  sectionKey: MateInstructionProfileSectionKey;
  content: string;
};

/** Provider 向けの指示文に添える区分別本文を指定する。 */
export type MateInstructionContentOptions = {
  sectionContents?: readonly MateInstructionSectionContent[];
};

const SECTION_HEADING_BY_KEY: Readonly<
  Record<MateInstructionProfileSectionKey, string>
> = {
  core: "Character / Persona",
  bond: "Interaction Style",
  work_style: "Work Style",
};

/** Mate の識別情報と投影を許可された区分の本文を、Provider 向けの Markdown に組み立てる。 */
export function buildMateInstructionContent(
  profile: MateProfile,
  options: MateInstructionContentOptions = {},
): string {
  const lines: string[] = [
    "### Identity",
    `- **displayName:** ${profile.displayName}`,
    ...buildOptionalDescription(profile.description),
    `- **state:** ${profile.state}`,
    "",
    ...buildProviderInstructionSectionLines(
      profile,
      options.sectionContents ?? [],
    ),
  ];

  return lines.join("\n");
}

/** 既存の指示文を残し、Mate の識別情報を含む管理ブロックだけを追加または置換する。 */
export function upsertMateInstructionBlock(
  existingText: string,
  profile: MateProfile,
): string {
  return upsertManagedBlock(existingText, {
    blockId: MATE_PROFILE_BLOCK_ID,
    title: "",
    content: buildMateInstructionContent(profile),
  });
}

/** 前後の空白を除き、説明が空でない場合だけ識別情報に説明行を添える。 */
function buildOptionalDescription(description: string): string[] {
  const normalized = description.trim();
  if (!normalized) {
    return [];
  }

  return [`- **description:** ${normalized}`];
}

/** 本文がある Provider 向け区分をプロフィールの区分順に並べ、該当区分がなければその旨を出力する。 */
function buildProviderInstructionSectionLines(
  profile: MateProfile,
  sectionContents: readonly MateInstructionSectionContent[],
): string[] {
  const contentBySection = new Map<MateInstructionProfileSectionKey, string>();
  for (const sectionContent of sectionContents) {
    const normalizedContent = normalizeSectionContent(sectionContent.content);
    if (normalizedContent) {
      contentBySection.set(sectionContent.sectionKey, normalizedContent);
    }
  }

  const lines: string[] = [];
  for (const section of profile.sections) {
    if (!isProviderInstructionProfileSection(section)) {
      continue;
    }

    const sectionKey = section.sectionKey as MateInstructionProfileSectionKey;
    const content = contentBySection.get(sectionKey);
    if (!content) {
      continue;
    }

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`### ${SECTION_HEADING_BY_KEY[sectionKey]}`);
    lines.push(...content.split("\n"));
  }

  if (lines.length === 0) {
    return [
      "### Current Profile",
      "- No provider-visible Mate Profile content is available.",
    ];
  }

  return lines;
}

/** 区分の用途と公開設定の両方から、Provider 向けの指示文に出せるか判定する。 */
export function isProviderInstructionProfileSection(
  section: MateProfile["sections"][number],
): boolean {
  if (section.projectionAllowed === false) {
    return false;
  }

  return isProviderInstructionProfileSectionKey(section.sectionKey);
}

/** 区分本文の改行を LF にそろえ、前後の空白を除く。 */
function normalizeSectionContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}
