import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import {
  validateMemoryAppendRequest,
  validateMemoryForgetRequest,
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
    assert.deepEqual(result.value.tags, [{ type: "topic", value: "V6" }]);
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

  it("valid forget request を正規化できる", () => {
    const result = validateMemoryForgetRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      entryIds: [" entry-a ", "entry-a", "entry-b"],
      reason: "privacy",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.entryIds, ["entry-a", "entry-b"]);
    assert.equal(result.value.reason, "privacy");
  });

  it("invalid schemaVersion を拒否する", () => {
    const result = validateMemorySearchRequest({
      schemaVersion: "withmate-memory-v0",
      targets: [projectTarget],
      query: "test",
    });

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

  it("invalid forget reason を拒否する", () => {
    const result = validateMemoryForgetRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
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
