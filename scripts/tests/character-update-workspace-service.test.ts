import assert from "node:assert/strict";
import test from "node:test";

import { CharacterUpdateWorkspaceService } from "../../src-electron/character-update-workspace-service.js";

test("CharacterUpdateWorkspaceService は workspace 情報と extract を返す", async () => {
  const service = new CharacterUpdateWorkspaceService({
    async getCharacter() {
      return {
        id: "char-1",
        name: "Muse",
        iconPath: "",
        description: "",
        roleMarkdown: "",
        updatedAt: "",
        themeColors: { main: "#111111", sub: "#222222" },
        sessionCopy: {} as never,
      };
    },
    getCharacterDirectoryPath() {
      return "C:/WithMate/characters/char-1";
    },
    getCharacterScopeByCharacterId() {
      return { id: "scope-1" } as never;
    },
    listCharacterMemoryEntries() {
      return [
        {
          id: "entry-1",
          characterScopeId: "scope-1",
          sourceSessionId: "session-1",
          category: "relationship",
          title: "距離感",
          detail: "落ち着いた伴走を好む",
          keywords: [],
          evidence: [],
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-29T00:00:00.000Z",
          lastUsedAt: null,
        },
      ];
    },
    async writeTextFile() {},
    createSession() {
      return { id: "session-1" } as never;
    },
  });

  const workspace = await service.getWorkspace("char-1");
  const extract = service.buildMemoryExtract("char-1");

  assert.equal(workspace?.workspacePath, "C:/WithMate/characters/char-1");
  assert.match(workspace?.codexInstructionPath ?? "", /AGENTS\.md$/);
  assert.equal(extract.entryCount, 1);
});

test("CharacterUpdateWorkspaceService は update session 作成時に instruction file を書いて session を返す", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const service = new CharacterUpdateWorkspaceService({
    async getCharacter() {
      return {
        id: "char-1",
        name: "Muse",
        iconPath: "",
        description: "",
        roleMarkdown: "",
        updatedAt: "",
        themeColors: { main: "#111111", sub: "#222222" },
        sessionCopy: {} as never,
      };
    },
    getCharacterDirectoryPath() {
      return "C:/WithMate/characters/char-1";
    },
    getCharacterScopeByCharacterId() {
      return null;
    },
    listCharacterMemoryEntries() {
      return [];
    },
    async writeTextFile(filePath, content) {
      writes.push({ path: filePath, content });
    },
    createSession(input) {
      return { id: "session-1", workspacePath: input.workspacePath, provider: input.provider } as never;
    },
  });

  const session = await service.createUpdateSession("char-1", "copilot");

  assert.equal(session.id, "session-1");
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /copilot-instructions\.md$/);
  assert.match(writes[0].content, /Character Update Workspace/);
});
