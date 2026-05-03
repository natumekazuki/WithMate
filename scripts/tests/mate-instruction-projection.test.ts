import assert from "node:assert/strict";
import test from "node:test";

import type { MateProfile } from "../../src/mate-state.js";
import {
  buildMateInstructionContent,
  upsertMateInstructionBlock,
  MATE_PROFILE_BLOCK_ID,
  MATE_PROFILE_BLOCK_TITLE,
} from "../../src-electron/mate-instruction-projection.js";

function createProfile(partial: Partial<MateProfile>): MateProfile {
  return {
    id: "current",
    state: "active",
    displayName: "Default Mate",
    description: "Default description",
    themeMain: "#6f8cff",
    themeSub: "#6fb8c7",
    avatarFilePath: "",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: null,
    profileGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    sections: [
      {
        sectionKey: "core",
        filePath: "mate/core.md",
        sha256: "",
        byteSize: 0,
        updatedByRevisionId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sectionKey: "bond",
        filePath: "mate/bond.md",
        sha256: "",
        byteSize: 0,
        updatedByRevisionId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sectionKey: "work_style",
        filePath: "mate/work-style.md",
        sha256: "",
        byteSize: 0,
        updatedByRevisionId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sectionKey: "notes",
        filePath: "mate/notes.md",
        sha256: "",
        byteSize: 0,
        updatedByRevisionId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...partial,
  };
}

function replacePath(profile: MateProfile, nextPath: string): MateProfile {
  return {
    ...profile,
    sections: profile.sections.map((section, index) => (index === 0 ? { ...section, filePath: nextPath } : section)),
  };
}

function extractProfileFileLines(content: string): string[] {
  return content.split("\n").filter((line) => line.includes("`") && line.includes("mate/"));
}

test("buildMateInstructionContent は MateProfile から安定した Markdown を生成する", () => {
  const profile = createProfile({
    displayName: "Tessa",
    description: "Core style and notes",
  });
  const content = buildMateInstructionContent(profile);

  assert.equal(
    content,
    [
      "### Identity",
      "- **displayName:** Tessa",
      "- **description:** Core style and notes",
      "- **state:** active",
      "",
      "### Profile Files",
      "- **core:** `mate/core.md`",
      "- **bond:** `mate/bond.md`",
      "- **work_style:** `mate/work-style.md`",
      "- **notes:** `mate/notes.md`",
    ].join("\n"),
  );
});

test("description が空なら description 行を出さない", () => {
  const profile = createProfile({ description: "" });
  const content = buildMateInstructionContent(profile);

  assert.equal(content.includes("- **description:**"), false);
});

test("upsertMateInstructionBlock は既存テキストを残して managed block を追記する", () => {
  const profile = createProfile({
    displayName: "Tessa",
    description: "desc",
  });
  const content = buildMateInstructionContent(profile);
  const expected = [
    "User note",
    `<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`,
    `## ${MATE_PROFILE_BLOCK_TITLE}`,
    ...content.split("\n"),
    `<!-- WITHMATE:END ${MATE_PROFILE_BLOCK_ID} -->`,
    "",
  ].join("\n");

  const updated = upsertMateInstructionBlock("User note\n", profile);

  assert.equal(updated, expected);
});

test("upsertMateInstructionBlock は既存 blockId を差し替える", () => {
  const profile = createProfile({
    displayName: "New Name",
    description: "updated",
  });
  const content = buildMateInstructionContent(profile);
  const existing =
    [
      "Header",
      `<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`,
      "## Old Profile",
      "old body",
      `<!-- WITHMATE:END ${MATE_PROFILE_BLOCK_ID} -->`,
      "Footer",
    ].join("\n") + "\n";

  const updated = upsertMateInstructionBlock(existing, profile);

  assert.equal(
    updated,
    [
      "Header",
      `<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`,
      `## ${MATE_PROFILE_BLOCK_TITLE}`,
      ...content.split("\n"),
      `<!-- WITHMATE:END ${MATE_PROFILE_BLOCK_ID} -->`,
      "Footer",
      "",
    ].join("\n"),
  );
});

test("絶対パスでも profile ファイル一覧は relativePath で生成される", () => {
  const absolutePathProfile = replacePath(createProfile({}), "C:\\Users\\example\\AppData\\Roaming\\WithMate\\mate\\core.md");
  const absoluteContent = buildMateInstructionContent(absolutePathProfile);
  const fileLines = extractProfileFileLines(absoluteContent);
  const absoluteSection = fileLines.at(0);

  assert.ok(absoluteSection !== undefined);
  assert.equal(absoluteSection?.includes("`/tmp/"), false);
  const match = absoluteSection?.match(/`([^`]+)`/);
  assert.ok(match);
  assert.equal(match ? match[1] : "", "mate/core.md");
});
