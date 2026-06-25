import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import {
  validateMemoryAppendRequest,
  validateMemoryForgetRequest,
  validateMemoryGetEntryRequest,
  validateMemoryListTagsRequest,
  validateMemoryResolveContextRequest,
  validateMemorySearchRequest,
} from "../../src/memory-v6/memory-validation.js";

const projectTarget = {
  owner: "project",
  scope: "project",
  project: { type: "path", path: "../repo-a" },
};

const characterTarget = {
  owner: "character",
  scope: "character",
  character: { type: "current" },
};

describe("memory-v6 contract validation", () => {
  it("valid resolve_context request を検証できる", () => {
    const result = validateMemoryResolveContextRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
  });

  it("valid search request を正規化できる", () => {
    const result = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "  approval mode  ",
      kinds: ["decision", "decision", "context"],
      tags: [
        { type: " topic ", value: " V6 " },
        { type: "topic", value: "v6" },
      ],
      limit: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.query, "approval mode");
    assert.deepEqual(result.value.kinds, ["decision", "context"]);
    assert.deepEqual(result.value.tags, [{ type: "topic", value: "V6", canonicalType: "topic", canonicalValue: "v6" }]);
  });

  it("valid append request を正規化できる", () => {
    const result = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: characterTarget,
      kind: "preference",
      title: " 呼び方 ",
      body: "ユーザーは短い呼び方を好む。",
      preview: "短い呼び方を好む。",
      tags: [{ type: "relationship", value: "tone" }],
      supersedes: ["entry-a", "entry-a"],
      idempotencyKey: " key-1 ",
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.title, "呼び方");
    assert.deepEqual(result.value.supersedes, ["entry-a"]);
    assert.equal(result.value.idempotencyKey, "key-1");
  });

  it("appendでtags省略を拒否し、空tagsは許可する", () => {
    const missingTags = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "body",
      preview: "preview",
    });
    assert.equal(missingTags.ok, false);
    assert.equal(missingTags.error.field, "tags");

    const emptyTags = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "body",
      preview: "preview",
      tags: [],
    });
    assert.equal(emptyTags.ok, true);
    assert.deepEqual(emptyTags.value.tags, []);
  });

  it("valid forget request を正規化できる", () => {
    const result = validateMemoryForgetRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      entryIds: [" entry-a ", "entry-a", "entry-b"],
      reason: "privacy",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.target, projectTarget);
    assert.deepEqual(result.value.entryIds, ["entry-a", "entry-b"]);
    assert.equal(result.value.reason, "privacy");
  });

  it("forget request は単一targetを必須にする", () => {
    const result = validateMemoryForgetRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryIds: ["entry-a"],
      reason: "privacy",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MEMORY_INVALID_FIELD");
    assert.equal(result.error.field, "target");
  });

  it("valid get_entry / list_tags request を正規化できる", () => {
    const getEntry = validateMemoryGetEntryRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryId: " entry-a ",
    });
    assert.equal(getEntry.ok, true);
    assert.equal(getEntry.value.entryId, "entry-a");

    const listTags = validateMemoryListTagsRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
    });
    assert.equal(listTags.ok, true);
    assert.deepEqual(listTags.value.targets, [projectTarget]);
  });

  it("invalid schemaVersion を拒否する", () => {
    const result = validateMemoryResolveContextRequest({ schemaVersion: "withmate-memory-v0" });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MEMORY_INVALID_SCHEMA_VERSION");
  });

  it("empty query を拒否する", () => {
    const result = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "   ",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.field, "query");
  });

  it("target なしの search を拒否する", () => {
    const result = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [],
      query: "test",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MEMORY_TARGET_REQUIRED");
  });

  it("invalid owner / scope combination を拒否する", () => {
    const result = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: {
        owner: "project",
        scope: "character",
        project: { type: "id", id: "project-a" },
        character: { type: "id", id: "char-a" },
      },
      kind: "decision",
      title: "title",
      body: "body",
      preview: "preview",
      tags: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MEMORY_INVALID_TARGET");
  });

  it("target variant外fieldを拒否する", () => {
    const characterCurrentWithId = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: {
        owner: "character",
        scope: "character",
        character: { type: "current", id: "char-a" },
      },
      kind: "preference",
      title: "title",
      body: "body",
      preview: "preview",
      tags: [],
    });
    assert.equal(characterCurrentWithId.ok, false);
    assert.equal(characterCurrentWithId.error.field, "target.character.id");

    const characterScopeWithProject = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: {
        owner: "character",
        scope: "character",
        character: { type: "id", id: "char-a" },
        project: { type: "id", id: "project-a" },
      },
      kind: "preference",
      title: "title",
      body: "body",
      preview: "preview",
      tags: [],
    });
    assert.equal(characterScopeWithProject.ok, false);
    assert.equal(characterScopeWithProject.error.field, "target.project");

    const projectIdWithPath = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a", path: "." } }],
      query: "test",
    });
    assert.equal(projectIdWithPath.ok, false);
    assert.equal(projectIdWithPath.error.field, "targets[0].project.path");

    const projectTargetWithCharacter = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [{
        owner: "project",
        scope: "project",
        project: { type: "id", id: "project-a" },
        character: { type: "id", id: "char-a" },
      }],
      query: "test",
    });
    assert.equal(projectTargetWithCharacter.ok, false);
    assert.equal(projectTargetWithCharacter.error.field, "targets[0].character");
  });

  it("targets上限とduplicate targetを拒否する", () => {
    const tooManyTargets = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: Array.from({ length: 6 }, (_, index) => ({
        owner: "project",
        scope: "project",
        project: { type: "id", id: `project-${index}` },
      })),
      query: "test",
    });
    assert.equal(tooManyTargets.ok, false);
    assert.equal(tooManyTargets.error.field, "targets");

    const duplicateTargets = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [
        { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      ],
      query: "test",
    });
    assert.equal(duplicateTargets.ok, false);
    assert.equal(duplicateTargets.error.code, "MEMORY_DUPLICATE_TARGET");
  });

  it("kindsのempty / duplicate / 上限を固定する", () => {
    const emptyKinds = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "test",
      kinds: [],
    });
    assert.equal(emptyKinds.ok, true);
    assert.equal(emptyKinds.value.kinds, undefined);

    const duplicateKinds = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "test",
      kinds: ["decision", "decision", "note"],
    });
    assert.equal(duplicateKinds.ok, true);
    assert.deepEqual(duplicateKinds.value.kinds, ["decision", "note"]);

    const tooManyKinds = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "test",
      kinds: Array.from({ length: 10 }, () => "decision"),
    });
    assert.equal(tooManyKinds.ok, false);
    assert.equal(tooManyKinds.error.field, "kinds");
  });

  it("oversized title / body / preview を拒否する", () => {
    const titleResult = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "x".repeat(161),
      body: "body",
      preview: "preview",
      tags: [],
    });
    assert.equal(titleResult.ok, false);
    assert.equal(titleResult.error.field, "title");

    const bodyResult = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "x".repeat(8_001),
      preview: "preview",
      tags: [],
    });
    assert.equal(bodyResult.ok, false);
    assert.equal(bodyResult.error.field, "body");

    const previewResult = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "body",
      preview: "x".repeat(281),
      tags: [],
    });
    assert.equal(previewResult.ok, false);
    assert.equal(previewResult.error.field, "preview");
  });

  it("null byte を拒否する", () => {
    const result = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "bad\0body",
      preview: "preview",
      tags: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.field, "body");
  });

  it("well-formedでないUnicodeを拒否し、valid surrogate pairは許可する", () => {
    const highSurrogate = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "\uD800",
      preview: "preview",
      tags: [],
    });
    assert.equal(highSurrogate.ok, false);
    assert.equal(highSurrogate.error.field, "body");

    const lowSurrogate = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "\uDC00",
      preview: "preview",
      tags: [],
    });
    assert.equal(lowSurrogate.ok, false);
    assert.equal(lowSurrogate.error.field, "body");

    const validPair = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      kind: "decision",
      title: "title",
      body: "emoji 😀",
      preview: "emoji 😀",
      tags: [{ type: "mood", value: "😀" }],
    });
    assert.equal(validPair.ok, true);
  });

  it("tag canonical keyをNFC lowercaseで固定する", () => {
    const result = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "test",
      tags: [
        { type: "Topic", value: "e\u0301" },
        { type: "topic", value: "\u00e9" },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.tags, [{
      type: "Topic",
      value: "e\u0301",
      canonicalType: "topic",
      canonicalValue: "\u00e9",
    }]);
  });

  it("invalid forget reason を拒否する", () => {
    const result = validateMemoryForgetRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: projectTarget,
      entryIds: ["entry-a"],
      reason: "purge",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.field, "reason");
  });

  it("provider-specific unknown field を拒否する", () => {
    const result = validateMemorySearchRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      targets: [projectTarget],
      query: "test",
      providerId: "codex",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MEMORY_UNKNOWN_FIELD");
    assert.equal(result.error.field, "request.providerId");
  });
});
