import type { MateProfile } from "../src/mate-state.js";
import { upsertManagedBlock } from "./managed-instruction-block.js";

export const MATE_PROFILE_BLOCK_ID = "mate-profile";
export const MATE_PROFILE_BLOCK_TITLE = "WithMate Mate Profile";

export function buildMateInstructionContent(profile: MateProfile): string {
  const lines: string[] = [
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
    .filter((section) => String(section.sectionKey) !== "project_digest")
    .map((section) => `- **${section.sectionKey}:** \`${relativeProfilePath(section.filePath)}\``);
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
