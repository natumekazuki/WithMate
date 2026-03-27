import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectMemoryEntry, SessionMemory } from "../../src/app-state.js";
import { retrieveProjectMemoryEntries } from "../../src-electron/project-memory-retrieval.js";

function makeEntry(
  partial: Partial<ProjectMemoryEntry> & Pick<ProjectMemoryEntry, "id" | "category" | "title" | "detail">,
): ProjectMemoryEntry {
  return {
    projectScopeId: "scope-1",
    sourceSessionId: "session-1",
    keywords: [],
    evidence: [],
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    lastUsedAt: null,
    ...partial,
  };
}

const sessionMemory: SessionMemory = {
  sessionId: "session-1",
  workspacePath: "workspace",
  threadId: "",
  schemaVersion: 1,
  goal: "Copilot approval UI の設計を整理する",
  decisions: [],
  openQuestions: ["approval callback の制約をどう扱うか"],
  nextActions: [],
  notes: [],
  updatedAt: "2026-03-28T00:00:00.000Z",
};

describe("retrieveProjectMemoryEntries", () => {
  it("userMessage と sessionMemory から関連 entry を最大 3 件返す", () => {
    const entries = retrieveProjectMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "decision",
          title: "Copilot approval callback は SDK 待ち",
          detail: "Copilot approval callback は SDK 待ちとして扱う",
          keywords: ["copilot", "approval"],
        }),
        makeEntry({
          id: "b",
          category: "context",
          title: "Character Memory は coding plane に入れない",
          detail: "Character Memory は main coding session prompt に入れない",
          keywords: ["character", "memory"],
        }),
        makeEntry({
          id: "c",
          category: "constraint",
          title: "approval UI は provider 差を吸収する",
          detail: "approval UI は provider 差を吸収する",
          keywords: ["approval", "ui"],
        }),
        makeEntry({
          id: "d",
          category: "context",
          title: "無関係な記憶",
          detail: "ホーム画面の背景色の話",
          keywords: ["background"],
        }),
      ],
      "Copilot の approval UI をどう扱う？",
      sessionMemory,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["a", "c"]);
  });

  it("日本語 query の部分一致でも relevant entry を拾える", () => {
    const entries = retrieveProjectMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "constraint",
          title: "承認UIはprovider差を吸収する",
          detail: "承認UIはprovider差を吸収する",
        }),
        makeEntry({
          id: "b",
          category: "context",
          title: "背景色の設計",
          detail: "ホーム画面の背景色をどうするか",
        }),
      ],
      "承認UIの方針どうする？",
      sessionMemory,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["a"]);
  });

  it("hit が無い時は空配列を返す", () => {
    const entries = retrieveProjectMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "context",
          title: "無関係な記憶",
          detail: "ホーム画面の背景色の話",
        }),
      ],
      "rate limit を調整する",
      sessionMemory,
    );

    assert.deepEqual(entries, []);
  });
});
