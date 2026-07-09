import assert from "node:assert/strict";
import test from "node:test";

import type { MateProfile } from "../../src/mate/mate-state.js";
import {
  buildMateInstructionContent,
  upsertMateInstructionBlock,
  MATE_PROFILE_BLOCK_ID,
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
      {
        sectionKey: "project_digest",
        filePath: "mate/project-digest.md",
        sha256: "",
        byteSize: 0,
        updatedByRevisionId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...partial,
  };
}

test("buildMateInstructionContent は MateProfile から安定した Markdown を生成する", () => {
  const profile = createProfile({
    displayName: "Tessa",
    description: "Core style and notes",
  });
  const content = buildMateInstructionContent(profile, {
    sectionContents: [
      { sectionKey: "core", content: "# Core\n- 穏やかな相棒として振る舞う。" },
      { sectionKey: "bond", content: "# Bond\n- あんた、と呼ぶ。" },
      { sectionKey: "work_style", content: "# Work Style\n- 変更前に確認する。" },
    ],
  });

  assert.equal(
    content,
    [
      "### Identity",
      "- **displayName:** Tessa",
      "- **description:** Core style and notes",
      "- **state:** active",
      "",
      "### Character / Persona",
      "# Core",
      "- 穏やかな相棒として振る舞う。",
      "",
      "### Interaction Style",
      "# Bond",
      "- あんた、と呼ぶ。",
      "",
      "### Work Style",
      "# Work Style",
      "- 変更前に確認する。",
    ].join("\n"),
  );
});

test("buildMateInstructionContent は projectionAllowed=false のセクションを除外する", () => {
  const profile = createProfile({});
  const gatedProfile = {
    ...profile,
    sections: profile.sections.map((section) => (section.sectionKey === "bond" ? { ...section, projectionAllowed: false } : section)),
  };
  const content = buildMateInstructionContent(gatedProfile, {
    sectionContents: [
      { sectionKey: "core", content: "- core body" },
      { sectionKey: "bond", content: "- hidden bond body" },
      { sectionKey: "work_style", content: "- work body" },
    ],
  });

  assert.equal(content.includes("### Interaction Style"), false);
  assert.equal(content.includes("hidden bond body"), false);
  assert.equal(content.includes("### Character / Persona"), true);
  assert.equal(content.includes("### Work Style"), true);
});

test("buildMateInstructionContent は projectionAllowed=true でも非 provider セクションを除外する", () => {
  const profile = createProfile({});
  const projectedProfile = {
    ...profile,
    sections: profile.sections.map((section) => (
      section.sectionKey === "notes" || section.sectionKey === "project_digest"
        ? { ...section, projectionAllowed: true }
        : section
    )),
  };
  const content = buildMateInstructionContent(projectedProfile, {
    sectionContents: [
      { sectionKey: "core", content: "- core body" },
      { sectionKey: "bond", content: "- bond body" },
      { sectionKey: "work_style", content: "- work body" },
    ],
  });

  assert.equal(content.includes("- **notes:**"), false);
  assert.equal(content.includes("- **project_digest:**"), false);
  assert.equal(content.includes("mate/notes.md"), false);
  assert.equal(content.includes("mate/project-digest.md"), false);
});

test("buildMateInstructionContent は動的な補助情報を含めない", () => {
  const profile = createProfile({
    displayName: "Tessa",
    description: "Core style and notes",
  });
  const content = buildMateInstructionContent(profile);

  assert.equal(content.includes("### Project Digest"), false);
  assert.equal(content.includes("- **project_digest:**"), false);
  assert.equal(content.includes("project-digest.md"), false);
  assert.equal(content.includes("- **notes:**"), false);
  assert.equal(content.includes("mate/notes.md"), false);
  assert.equal(content.includes("mate/core.md"), false);
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
      ...content.split("\n"),
      `<!-- WITHMATE:END ${MATE_PROFILE_BLOCK_ID} -->`,
      "Footer",
      "",
    ].join("\n"),
  );
});

test("profile file path は provider instruction に出力しない", () => {
  const profile = createProfile({
    sections: [
      {
        sectionKey: "core",
        filePath: "C:\\Users\\example\\AppData\\Roaming\\WithMate\\mate\\core.md",
        sha256: "",
        byteSize: 0,
        updatedByRevisionId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const content = buildMateInstructionContent(profile, {
    sectionContents: [{ sectionKey: "core", content: "- core body" }],
  });

  assert.equal(content.includes("C:\\Users"), false);
  assert.equal(content.includes("mate/core.md"), false);
  assert.equal(content.includes("- core body"), true);
});

test("buildMateInstructionContent は固定 priority ガードを出力しない", () => {
  const profile = createProfile({ displayName: "Tessa" });
  const content = buildMateInstructionContent(profile);

  assert.equal(content.startsWith("### Identity"), true);
  assert.equal(content.includes("## Priority"), false);
  assert.equal(content.includes("coding correctness"), false);
  assert.equal(content.includes("safety / security"), false);
});
