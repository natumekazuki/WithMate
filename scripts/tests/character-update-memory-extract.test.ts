import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterMemoryEntry } from "../../src/memory-state.js";
import { buildCharacterUpdateMemoryExtract } from "../../src-electron/character-update-memory-extract.js";

function createEntry(partial: Partial<CharacterMemoryEntry> & Pick<CharacterMemoryEntry, "id" | "category" | "title" | "detail">): CharacterMemoryEntry {
  return {
    characterScopeId: "scope-1",
    sourceSessionId: "session-1",
    keywords: [],
    evidence: [],
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    lastUsedAt: null,
    ...partial,
  };
}

test("buildCharacterUpdateMemoryExtract は category ごとに markdown を整形する", () => {
  const extract = buildCharacterUpdateMemoryExtract("char-1", [
    createEntry({ id: "1", category: "relationship", title: "距離感", detail: "落ち着いた伴走を好む" }),
    createEntry({ id: "2", category: "preference", title: "反応", detail: "短く返すより少し余韻がある言い方を好む", evidence: ["会話ログ"] }),
  ]);

  assert.equal(extract.characterId, "char-1");
  assert.equal(extract.entryCount, 2);
  assert.match(extract.text, /## Relationship/);
  assert.match(extract.text, /- 距離感: 落ち着いた伴走を好む/);
  assert.match(extract.text, /## Preference/);
  assert.match(extract.text, /evidence: 会話ログ/);
});

test("buildCharacterUpdateMemoryExtract は entry がない時は空 text を返す", () => {
  const extract = buildCharacterUpdateMemoryExtract("char-1", []);

  assert.equal(extract.entryCount, 0);
  assert.equal(extract.text, "");
});
