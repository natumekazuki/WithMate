import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterMemoryEntry } from "../../src/app-state.js";
import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { retrieveCharacterMemoryEntries } from "../../src-electron/character-memory-retrieval.js";

function makeEntry(
  partial: Partial<CharacterMemoryEntry> & Pick<CharacterMemoryEntry, "id" | "category" | "title" | "detail">,
): CharacterMemoryEntry {
  return {
    characterScopeId: "scope-1",
    sourceSessionId: "session-1",
    keywords: [],
    evidence: [],
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    lastUsedAt: null,
    ...partial,
  };
}

function createSession(messages: string[]) {
  const session = buildNewSession({
    taskTitle: "Character retrieval",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });

  return {
    ...session,
    messages: messages.map((text, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as const,
      text,
    })),
  };
}

describe("retrieveCharacterMemoryEntries", () => {
  it("recent conversation と関連する entry を優先する", () => {
    const session = createSession([
      "今日は焦り気味かも",
      "了解、落ち着いて整理しよう",
      "その穏やかな言い方は結構好き",
    ]);

    const entries = retrieveCharacterMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかに整理してくれる距離感を好む",
          keywords: ["穏やか", "距離感"],
        }),
        makeEntry({
          id: "b",
          category: "shared_moment",
          title: "approval UI の議論",
          detail: "approval UI の方針を整理した",
          keywords: ["approval", "ui"],
        }),
      ],
      session,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["a"]);
  });

  it("弱い一致だけの entry は threshold で落とす", () => {
    const session = createSession([
      "穏やかな言い方が好き",
      "了解、距離感はそこを意識するね",
    ]);

    const entries = retrieveCharacterMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          keywords: ["穏やか", "伴走"],
        }),
        makeEntry({
          id: "b",
          category: "tone",
          title: "好き",
          detail: "好きという雑多なメモ",
          keywords: ["好き"],
        }),
      ],
      session,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["a"]);
  });

  it("hit が無い時は recent fallback を返す", () => {
    const session = createSession([
      "今日は新しい話題に行こう",
      "了解",
    ]);

    const entries = retrieveCharacterMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          updatedAt: "2026-03-28T10:00:00.000Z",
        }),
        makeEntry({
          id: "b",
          category: "preference",
          title: "簡潔な返答",
          detail: "簡潔な返答を好む",
          lastUsedAt: "2026-03-28T11:00:00.000Z",
          updatedAt: "2026-03-28T09:00:00.000Z",
        }),
      ],
      session,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["b", "a"]);
  });

  it("同一 category/title/detail の重複 entry は 1 件に絞る", () => {
    const session = createSession([
      "穏やかな言い方が好き",
      "その距離感でいこう",
    ]);

    const entries = retrieveCharacterMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          updatedAt: "2026-03-28T09:00:00.000Z",
        }),
        makeEntry({
          id: "b",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          updatedAt: "2026-03-28T10:00:00.000Z",
        }),
      ],
      session,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["b"]);
  });

  it("同程度に relevant な entry では最近使われたものを優先する", () => {
    const session = createSession([
      "穏やかな言い方が好き",
      "その距離感でいこう",
    ]);

    const entries = retrieveCharacterMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          keywords: ["穏やか", "距離感"],
          updatedAt: "2025-10-01T00:00:00.000Z",
        }),
        makeEntry({
          id: "b",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          keywords: ["穏やか", "距離感"],
          lastUsedAt: "2026-03-28T11:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      session,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["b"]);
  });

  it("古くても十分 relevant な entry は retrieval に残る", () => {
    const session = createSession([
      "穏やかな言い方が好き",
      "その距離感でいこう",
    ]);

    const entries = retrieveCharacterMemoryEntries(
      [
        makeEntry({
          id: "a",
          category: "relationship",
          title: "穏やかな伴走感",
          detail: "穏やかな伴走感を好む",
          keywords: ["穏やか", "距離感"],
          updatedAt: "2025-10-01T00:00:00.000Z",
        }),
      ],
      session,
    );

    assert.deepEqual(entries.map((entry) => entry.id), ["a"]);
  });
});
