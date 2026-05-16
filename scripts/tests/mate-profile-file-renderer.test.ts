import assert from "node:assert/strict";
import test from "node:test";

import type { MateProfile } from "../../src/mate/mate-state.js";
import type { MateProfileItem } from "../../src-electron/mate-profile-item-storage.js";
import {
  renderMateProfileFiles,
  renderProjectDigestProjectionText,
} from "../../src-electron/mate-profile-file-renderer.js";

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
    projectDigestId: partial.projectDigestId ?? null,
    category: partial.category,
    claimKey: partial.claimKey ?? partial.id,
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

test("renderMateProfileFiles は bond / work_style を active かつ projectionAllowed で完全再生成する", () => {
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
      id: "hidden-bond",
      sectionKey: "bond",
      category: "relationship",
      renderedText: "これは差分編集で残ってはいけない",
      projectionAllowed: false,
    }),
    createItem({
      id: "work-style-keep",
      sectionKey: "work_style",
      category: "work_style",
      renderedText: "最初に方針を共有する",
      salienceScore: 74,
    }),
    createItem({
      id: "work-style-hidden",
      sectionKey: "work_style",
      category: "work_style",
      renderedText: "これは差分更新で残ってはいけない",
      state: "disabled",
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
  const workStyle = files.find((file) => file.sectionKey === "work_style");

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
  assert.equal(
    workStyle?.content,
    [
      "# Work Style",
      "",
      "## Work Style",
      "- 最初に方針を共有する",
      "",
    ].join("\n"),
  );
  assert.equal(core?.content.includes("これは投影しない"), false);
  assert.equal(bond?.content.includes("これは差分編集で残ってはいけない"), false);
  assert.equal(workStyle?.content.includes("これは差分更新で残ってはいけない"), false);
  assert.equal(files.some((file) => file.content.includes("Project note")), false);
});

test("renderProjectDigestProjectionText は claimKey と updatedAt でソートし、対象条件以外を除外して生成する", () => {
  const rendered = renderProjectDigestProjectionText("digest-1", { items: [
    createItem({
      id: "digest-newer",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "最新",
      claimKey: "a",
      updatedAt: "2026-01-02T00:00:00.000Z",
      projectDigestId: "digest-1",
    }),
    createItem({
      id: "digest-older",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "旧い",
      claimKey: "a",
      updatedAt: "2026-01-01T00:00:00.000Z",
      projectDigestId: "digest-1",
    }),
    createItem({
      id: "digest-b",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "別キー",
      claimKey: "b",
      updatedAt: "2026-01-03T00:00:00.000Z",
      projectDigestId: "digest-1",
    }),
    createItem({
      id: "digest-other-digest",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "別プロジェクト",
      claimKey: "a",
      updatedAt: "2026-01-03T00:00:00.000Z",
      projectDigestId: "digest-2",
    }),
    createItem({
      id: "digest-hidden-section",
      sectionKey: "bond",
      category: "relationship",
      renderedText: "bond text",
      claimKey: "bond-item",
      projectDigestId: "digest-1",
    }),
    createItem({
      id: "digest-inactive",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "非アクティブ",
      claimKey: "b",
      updatedAt: "2026-01-04T00:00:00.000Z",
      projectDigestId: "digest-1",
      state: "disabled",
    }),
    createItem({
      id: "digest-hidden",
      sectionKey: "project_digest",
      category: "project_context",
      renderedText: "投影対象外",
      claimKey: "b",
      updatedAt: "2026-01-05T00:00:00.000Z",
      projectDigestId: "digest-1",
      projectionAllowed: false,
    }),
  ]});

  assert.equal(
    rendered,
    [
      "### Project Digest",
      "- **a:** 最新",
      "- **a:** 旧い",
      "- **b:** 別キー",
    ].join("\n"),
  );
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
