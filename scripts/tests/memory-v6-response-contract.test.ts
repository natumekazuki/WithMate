import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import {
  createMemoryAppendResponse,
  createMemoryForgetResponse,
  createMemoryGetEntryResponse,
  createMemoryListTagsResponse,
  createMemorySearchResponse,
  type MemoryAppendResponse,
  type MemoryGetEntryResponse,
  type MemorySearchResponse,
} from "../../src/memory-v6/memory-response-contract.js";
import { type MemoryEntryDetail } from "../../src/memory-v6/memory-state.js";

const baseEntry = {
  id: "mem_1",
  owner: { type: "project", id: "project-a" },
  scope: { type: "project", id: "project-a" },
  kind: "decision",
  title: "CLI認証方針",
  body: "CLIはWithMate起動中のruntime APIだけに接続し、DBを直接読まない。",
  preview: "CLIはWithMate起動中のruntime APIだけに接続する。",
  state: "active",
  tags: [{ type: "topic", value: "memory" }],
  source: {
    type: "agent",
    sessionId: "session-a",
    messageId: "message-a",
    providerId: "codex",
  },
  supersedes: [],
  supersededBy: null,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
  forgottenAt: null,
} satisfies MemoryEntryDetail;

function entryWith(overrides: Partial<MemoryEntryDetail>): MemoryEntryDetail {
  return {
    ...baseEntry,
    ...overrides,
  };
}

describe("memory-v6 response contract", () => {
  it("search responseはactive entryだけをpreview hitとして返し、body/stateを含めない", () => {
    const response = createMemorySearchResponse([
      baseEntry,
      entryWith({ id: "mem_2", state: "superseded", supersededBy: "mem_4" }),
      entryWith({ id: "mem_3", state: "forgotten", forgottenAt: "2026-06-22T01:00:00.000Z" }),
    ], "cursor-1");

    assert.equal(response.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
    assert.equal(response.nextCursor, "cursor-1");
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0].id, "mem_1");
    assert.equal("body" in response.items[0], false);
    assert.equal("state" in response.items[0], false);

    const typed = response satisfies MemorySearchResponse;
    assert.equal(typed.items[0].preview, baseEntry.preview);
  });

  it("get_entry responseはactive entryのfull bodyを返す", () => {
    const response = createMemoryGetEntryResponse(baseEntry);

    assert.equal(response.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
    assert.equal("entry" in response, true);
    assert.equal((response as MemoryGetEntryResponse).entry.body, baseEntry.body);
  });

  it("get_entry responseはforgotten / superseded / missingをnot found errorにする", () => {
    const forgotten = createMemoryGetEntryResponse(entryWith({ state: "forgotten", forgottenAt: "2026-06-22T01:00:00.000Z" }));
    const superseded = createMemoryGetEntryResponse(entryWith({ state: "superseded", supersededBy: "mem_9" }));
    const missing = createMemoryGetEntryResponse(null);

    for (const response of [forgotten, superseded, missing]) {
      assert.equal(response.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
      assert.equal("error" in response, true);
      assert.equal(response.error.code, "MEMORY_ENTRY_NOT_FOUND");
    }
  });

  it("append responseはentry summaryとcreatedを返し、bodyを含めない", () => {
    const response = createMemoryAppendResponse(baseEntry, true);

    assert.equal(response.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
    assert.equal(response.created, true);
    assert.equal(response.entry.id, baseEntry.id);
    assert.equal(response.entry.state, "active");
    assert.equal("body" in response.entry, false);

    const typed = response satisfies MemoryAppendResponse;
    assert.equal(typed.entry.preview, baseEntry.preview);
  });

  it("list_tags responseはschemaVersion付きでtag一覧を返す", () => {
    const response = createMemoryListTagsResponse([{ type: "topic", value: "memory" }]);

    assert.deepEqual(response, {
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      tags: [{ type: "topic", value: "memory" }],
    });
  });

  it("forget responseは複数entryの結果をentryIdごとに返す", () => {
    const response = createMemoryForgetResponse([
      { entryId: "mem_1", status: "forgotten" },
      { entryId: "mem_2", status: "already_forgotten" },
      { entryId: "mem_3", status: "not_found" },
      { entryId: "mem_4", status: "forbidden" },
    ]);

    assert.equal(response.schemaVersion, MEMORY_V6_SCHEMA_VERSION);
    assert.deepEqual(response.results.map((result) => result.status), [
      "forgotten",
      "already_forgotten",
      "not_found",
      "forbidden",
    ]);
  });
});
