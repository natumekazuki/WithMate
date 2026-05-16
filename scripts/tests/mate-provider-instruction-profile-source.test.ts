import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MateProfile } from "../../src/mate/mate-state.js";
import { buildMateProviderInstructionProfileSectionReader } from "../../src-electron/mate-provider-instruction-profile-source.js";
import type { MateProfileItem } from "../../src-electron/mate-profile-item-storage.js";

const NOW = "2026-01-01T00:00:00.000Z";

function createProfile(): MateProfile {
  return {
    id: "current",
    state: "active",
    displayName: "Mia",
    description: "",
    themeMain: "#6f8cff",
    themeSub: "#6fb8c7",
    avatarFilePath: "",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: "revision-1",
    profileGeneration: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    sections: [
      {
        sectionKey: "core",
        filePath: "mate/core.md",
        sha256: "sha256-core",
        byteSize: 0,
        updatedByRevisionId: "revision-1",
        updatedAt: NOW,
      },
      {
        sectionKey: "bond",
        filePath: "mate/bond.md",
        sha256: "sha256-bond",
        byteSize: 0,
        updatedByRevisionId: "revision-1",
        updatedAt: NOW,
      },
      {
        sectionKey: "work_style",
        filePath: "mate/work-style.md",
        sha256: "sha256-work-style",
        byteSize: 0,
        updatedByRevisionId: "revision-1",
        updatedAt: NOW,
      },
      {
        sectionKey: "notes",
        filePath: "mate/notes.md",
        sha256: "sha256-notes",
        byteSize: 0,
        updatedByRevisionId: "revision-1",
        updatedAt: NOW,
      },
      {
        sectionKey: "project_digest",
        filePath: "mate/project-digest.md",
        sha256: "sha256-project-digest",
        byteSize: 0,
        updatedByRevisionId: "revision-1",
        updatedAt: NOW,
      },
    ],
  };
}

function createProfileItem(partial: Partial<MateProfileItem> = {}): MateProfileItem {
  const id = partial.id ?? "item-1";
  return {
    id,
    sectionKey: "core",
    projectDigestId: null,
    category: "persona",
    claimKey: id,
    claimValue: id,
    claimValueNormalized: id,
    renderedText: "- DB正本の記憶",
    normalizedClaim: id,
    confidence: 80,
    salienceScore: 80,
    recurrenceCount: 1,
    projectionAllowed: true,
    state: "active",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    createdRevisionId: "revision-1",
    updatedRevisionId: "revision-1",
    disabledRevisionId: null,
    forgottenRevisionId: null,
    disabledAt: null,
    forgottenAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
    ...partial,
  };
}

describe("buildMateProviderInstructionProfileSectionReader", () => {
  it("active かつ projectionAllowed の profile item から section text を生成する", async () => {
    const profile = createProfile();
    const reader = buildMateProviderInstructionProfileSectionReader(profile, [
      createProfileItem({ id: "active-core", renderedText: "- DB正本の内容" }),
      createProfileItem({ id: "hidden-core", renderedText: "- 投影禁止の内容", projectionAllowed: false }),
      createProfileItem({ id: "forgotten-core", renderedText: "- 忘却済みの内容", state: "forgotten" }),
      createProfileItem({ id: "active-bond", sectionKey: "bond", renderedText: "- 関係性の内容" }),
    ]);

    const coreSection = profile.sections.find((section) => section.sectionKey === "core");
    const bondSection = profile.sections.find((section) => section.sectionKey === "bond");
    assert.ok(coreSection);
    assert.ok(bondSection);

    const coreText = await reader(coreSection);
    const bondText = await reader(bondSection);

    assert.match(coreText ?? "", /DB正本の内容/);
    assert.doesNotMatch(coreText ?? "", /投影禁止|忘却済み/);
    assert.match(bondText ?? "", /関係性の内容/);
  });
});
