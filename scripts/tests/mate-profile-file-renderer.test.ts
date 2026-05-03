import assert from "node:assert/strict";
import test from "node:test";

import type { MateProfile } from "../../src/mate-state.js";
import type { MateProfileItem } from "../../src-electron/mate-profile-item-storage.js";
import { renderMateProfileFiles } from "../../src-electron/mate-profile-file-renderer.js";

const BASE_TIME = "2026-01-01T00:00:00.000Z";

function createProfile(partial: Partial<MateProfile> = {}): MateProfile {
  return {
    id: "current",
    state: "active",
    displayName: "Mika",
    description: "small companion",
    themeMain: "#6f8cff",
    themeSub: "#6fb8c7",
    avatarFilePath: "",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: "rev-1",
    profileGeneration: 1,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    deletedAt: null,
    sections: [
      section("core", "mate/core.md"),
      section("bond", "mate/bond.md"),
      section("work_style", "mate/work-style.md"),
      section("notes", "mate/notes.md"),
    ],
    ...partial,
  };
}

function section(sectionKey: MateProfile["sections"][number]["sectionKey"], filePath: string): MateProfile["sections"][number] {
  return {
    sectionKey,
    filePath,
    sha256: "",
    byteSize: 0,
    updatedByRevisionId: null,
    updatedAt: BASE_TIME,
  };
}

function createItem(partial: Partial<MateProfileItem> & Pick<MateProfileItem, "id" | "sectionKey" | "category" | "renderedText">): MateProfileItem {
  return {
    id: partial.id,
    sectionKey: partial.sectionKey,
    projectDigestId: null,
    category: partial.category,
    claimKey: partial.id,
    claimValue: "",
    claimValueNormalized: "",
    renderedText: partial.renderedText,
    normalizedClaim: partial.renderedText.toLowerCase(),
    confidence: partial.confidence ?? 80,
    salienceScore: partial.salienceScore ?? 50,
    recurrenceCount: partial.recurrenceCount ?? 1,
    projectionAllowed: partial.projectionAllowed ?? true,
    state: partial.state ?? "active",
    firstSeenAt: BASE_TIME,
    lastSeenAt: BASE_TIME,
    createdRevisionId: null,
    updatedRevisionId: null,
    disabledRevisionId: null,
    forgottenRevisionId: null,
    disabledAt: null,
    forgottenAt: null,
    createdAt: BASE_TIME,
    updatedAt: partial.updatedAt ?? BASE_TIME,
    tags: [],
  };
}

test("renderMateProfileFiles は profile items から Mate ファイル本文を安定生成する", () => {
  const profile = createProfile();
  const files = renderMateProfileFiles(profile, [
    createItem({
      id: "voice-low",
      sectionKey: "core",
      category: "voice",
      renderedText: "落ち着いた短い返答を好む",
      salienceScore: 80,
    }),
    createItem({
      id: "bond",
      sectionKey: "bond",
      category: "relationship",
      renderedText: "ユーザーとはほどよい距離感で話す",
      salienceScore: 70,
    }),
    createItem({
      id: "hidden",
      sectionKey: "core",
      category: "note",
      renderedText: "これは投影しない",
      projectionAllowed: false,
    }),
    createItem({
      id: "project",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "Project note",
      projectDigestId: "pd-1",
    }),
  ]);

  const core = files.find((file) => file.sectionKey === "core");
  const bond = files.find((file) => file.sectionKey === "bond");

  assert.equal(files.length, 4);
  assert.equal(core?.relativePath, "mate/core.md");
  assert.equal(
    core?.content,
    [
      "# Core",
      "",
      "## Identity",
      "- Name: Mika",
      "- Description: small companion",
      "",
      "## Voice",
      "- 落ち着いた短い返答を好む",
      "",
    ].join("\n"),
  );
  assert.equal(
    bond?.content,
    [
      "# Bond",
      "",
      "## Relationship",
      "- ユーザーとはほどよい距離感で話す",
      "",
    ].join("\n"),
  );
  assert.equal(core?.content.includes("これは投影しない"), false);
  assert.equal(files.some((file) => file.content.includes("Project note")), false);
});

test("絶対パスの section path は mate/ からの相対パスに丸める", () => {
  const profile = createProfile({
    sections: [
      section("core", "C:\\Users\\example\\AppData\\Roaming\\WithMate\\mate\\core.md"),
      section("bond", "mate/bond.md"),
      section("work_style", "mate/work-style.md"),
      section("notes", "mate/notes.md"),
    ],
  });

  const files = renderMateProfileFiles(profile, []);

  assert.equal(files[0].relativePath, "mate/core.md");
});
