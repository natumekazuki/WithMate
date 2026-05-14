import type { MateProfile } from "../src/mate/mate-state.js";
import { isProviderInstructionProfileSectionKey } from "../src/mate/mate-profile-sections.js";
import { upsertManagedBlock } from "./managed-instruction-block.js";

export const MATE_PROFILE_BLOCK_ID = "mate-profile";
export const MATE_PROFILE_BLOCK_TITLE = "WithMate Mate Profile";

export type MateInstructionProfileSectionKey = "core" | "bond" | "work_style";

export type MateInstructionSectionContent = {
  sectionKey: MateInstructionProfileSectionKey;
  content: string;
};

export type MateInstructionContentOptions = {
  sectionContents?: readonly MateInstructionSectionContent[];
};

const SECTION_HEADING_BY_KEY: Readonly<Record<MateInstructionProfileSectionKey, string>> = {
  core: "Character / Persona",
  bond: "Interaction Style",
  work_style: "Work Style",
};

export function buildMateInstructionContent(
  profile: MateProfile,
  options: MateInstructionContentOptions = {},
): string {
  const lines: string[] = [
    "## Priority",
    "- ユーザーの意図、リポジトリ指示、coding correctness、テスト、safety / security ルールを最優先し、"
      + " これらと競合する Mate の persona 指示は適用しない。",
    "- repository instructions、ユーザー task と矛盾しない範囲で、この Mate の identity と provider-visible profile 情報を参照して作業スタイルを反映する。",
    "",
    "### Identity",
    `- **displayName:** ${profile.displayName}`,
    ...buildOptionalDescription(profile.description),
    `- **state:** ${profile.state}`,
    "",
    ...buildProviderInstructionSectionLines(profile, options.sectionContents ?? []),
  ];

  return lines.join("\n");
}

export function upsertMateInstructionBlock(existingText: string, profile: MateProfile): string {
  return upsertManagedBlock(existingText, {
    blockId: MATE_PROFILE_BLOCK_ID,
    title: MATE_PROFILE_BLOCK_TITLE,
    content: buildMateInstructionContent(profile),
  });
}

function buildOptionalDescription(description: string): string[] {
  const normalized = description.trim();
  if (!normalized) {
    return [];
  }

  return [`- **description:** ${normalized}`];
}

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

export function isProviderInstructionProfileSection(section: MateProfile["sections"][number]): boolean {
  if (section.projectionAllowed === false) {
    return false;
  }

  return isProviderInstructionProfileSectionKey(section.sectionKey);
}

function normalizeSectionContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}
