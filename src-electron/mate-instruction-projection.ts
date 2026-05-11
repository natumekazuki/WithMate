import type { MateProfile } from "../src/mate/mate-state.js";
import { upsertManagedBlock } from "./managed-instruction-block.js";

export const MATE_PROFILE_BLOCK_ID = "mate-profile";
export const MATE_PROFILE_BLOCK_TITLE = "WithMate Mate Profile";

export function buildMateInstructionContent(profile: MateProfile): string {
  const lines: string[] = [
    "## Priority",
    "- ユーザーの意図、リポジトリ指示、coding correctness、テスト、safety / security ルールを最優先し、"
      + " これらと競合する Mate の persona 指示は適用しない。",
    "- repository instructions、ユーザー task と矛盾しない範囲で、この Mate の identity と profile file 情報を参照して作業スタイルを反映する。",
    "",
    "### Identity",
    `- **displayName:** ${profile.displayName}`,
    ...buildOptionalDescription(profile.description),
    `- **state:** ${profile.state}`,
    "",
    "### Profile Files",
    ...buildProfileFileLines(profile.sections),
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

function buildProfileFileLines(sections: MateProfile["sections"]): string[] {
  return sections
    .filter(isProviderInstructionProfileSection)
    .map((section) => `- **${section.sectionKey}:** \`${relativeProfilePath(section.filePath)}\``);
}

function isProviderInstructionProfileSection(section: MateProfile["sections"][number]): boolean {
  if (section.projectionAllowed === false) {
    return false;
  }

  return section.sectionKey === "core" || section.sectionKey === "bond" || section.sectionKey === "work_style";
}

function relativeProfilePath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const mateSegmentIndex = normalizedPath.indexOf("/mate/");
  if (mateSegmentIndex >= 0) {
    return normalizedPath.slice(mateSegmentIndex + 1);
  }

  const withoutDrive = normalizedPath.replace(/^[A-Za-z]:\//, "");

  return withoutDrive.startsWith("/") ? withoutDrive.slice(1) : withoutDrive;
}
