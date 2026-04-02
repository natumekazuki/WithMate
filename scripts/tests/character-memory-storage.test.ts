import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { CharacterMemoryStorage } from "../../src-electron/character-memory-storage.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

function createSession(workspacePath: string) {
  return buildNewSession({
    taskTitle: "Character Memory foundation",
    workspaceLabel: path.basename(workspacePath),
    workspacePath,
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

describe("CharacterMemoryStorage", () => {
  it("character id 単位で scope を再利用し、display name を更新できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CharacterMemoryStorage | null = null;

    try {
      storage = new CharacterMemoryStorage(dbPath);
      const first = storage.ensureCharacterScope({
        characterId: "char-a",
        displayName: "A",
      });
      const second = storage.ensureCharacterScope({
        characterId: "char-a",
        displayName: "A-Updated",
      });

      assert.equal(first.id, second.id);
      assert.equal(second.displayName, "A-Updated");
      assert.equal(storage.listCharacterScopes().length, 1);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("同一 category/title/detail の entry は再利用する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CharacterMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      storage = new CharacterMemoryStorage(dbPath);
      const scope = storage.ensureCharacterScope({
        characterId: "char-a",
        displayName: "A",
      });

      const first = storage.upsertCharacterMemoryEntry({
        characterScopeId: scope.id,
        sourceSessionId: null,
        category: "relationship",
        title: "距離感",
        detail: "ユーザーとの距離感は落ち着いた友人寄りに保つ",
        keywords: ["距離感", "友人"],
        evidence: ["docs/design/character-memory-storage.md"],
      });
      const second = storage.upsertCharacterMemoryEntry({
        characterScopeId: scope.id,
        sourceSessionId: null,
        category: "relationship",
        title: "距離感",
        detail: "ユーザーとの距離感は落ち着いた友人寄りに保つ",
        keywords: ["距離感"],
        evidence: [],
      });

      assert.equal(first.id, second.id);
      assert.equal(storage.listCharacterMemoryEntries(scope.id).length, 1);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("source_session_id は session 削除時に null へ落ちる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const workspacePath = path.join(tempDirectory, "workspace");
    let storage: CharacterMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      sessionStorage = new SessionStorage(dbPath);
      const session = sessionStorage.upsertSession(createSession(workspacePath));
      storage = new CharacterMemoryStorage(dbPath);
      const scope = storage.ensureCharacterScope({
        characterId: session.characterId,
        displayName: session.character,
      });

      const entry = storage.upsertCharacterMemoryEntry({
        characterScopeId: scope.id,
        sourceSessionId: session.id,
        category: "shared_moment",
        title: "初回の印象",
        detail: "最初のやり取りはかなり落ち着いた空気で始まった",
        keywords: [],
        evidence: [],
      });

      sessionStorage.deleteSession(session.id);

      const loaded = storage.listCharacterMemoryEntries(scope.id).find((candidate) => candidate.id === entry.id);
      assert.ok(loaded);
      assert.equal(loaded.sourceSessionId, null);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("retrieval に使った entry の lastUsedAt を更新できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CharacterMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      storage = new CharacterMemoryStorage(dbPath);
      const scope = storage.ensureCharacterScope({
        characterId: "char-a",
        displayName: "A",
      });

      const entry = storage.upsertCharacterMemoryEntry({
        characterScopeId: scope.id,
        sourceSessionId: null,
        category: "tone",
        title: "話し方",
        detail: "少しフラットで、落ち着いた調子を維持する",
        keywords: [],
        evidence: [],
      });

      assert.equal(entry.lastUsedAt, null);
      storage.markCharacterMemoryEntriesUsed([entry.id]);

      const loaded = storage.listCharacterMemoryEntries(scope.id).find((candidate) => candidate.id === entry.id);
      assert.ok(loaded?.lastUsedAt);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("entry 削除時に最後の scope も自動で掃除する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-memory-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CharacterMemoryStorage | null = null;
    let sessionStorage: SessionStorage | null = null;

    try {
      sessionStorage = new SessionStorage(dbPath);
      storage = new CharacterMemoryStorage(dbPath);
      const scope = storage.ensureCharacterScope({
        characterId: "char-a",
        displayName: "A",
      });
      const entry = storage.upsertCharacterMemoryEntry({
        characterScopeId: scope.id,
        sourceSessionId: null,
        category: "boundary",
        title: "scope cleanup",
        detail: "最後の entry を消したら scope も掃除する",
        keywords: [],
        evidence: [],
      });

      storage.deleteCharacterMemoryEntry(entry.id);

      assert.equal(storage.listCharacterScopes().length, 0);
    } finally {
      storage?.close();
      sessionStorage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
