import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterProfile, CreateCharacterInput } from "../../src/character-state.js";
import type { Session } from "../../src/session-state.js";
import { buildNewSession } from "../../src/session-state.js";
import { CharacterRuntimeService } from "../../src-electron/character-runtime-service.js";

function createCharacter(overrides?: Partial<CharacterProfile>): CharacterProfile {
  return {
    id: "char-1",
    name: "Muse",
    iconPath: "",
    description: "",
    roleMarkdown: "",
    themeColors: { main: "#111111", sub: "#222222" },
    sessionCopy: {
      pending: [],
      retryTitle: [],
      latestCommandEmpty: [],
      latestCommandWaiting: [],
      contextEmpty: [],
      changedFilesEmpty: [],
    },
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    ...overrides,
  };
}

function createSession(characterId = "char-1", character = "Muse"): Session {
  return buildNewSession({
    taskTitle: "task",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId,
    character,
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    approvalMode: "provider-controlled",
  });
}

test("CharacterRuntimeService は character 更新時に session 表示を同期する", async () => {
  const storedSessions = [createSession()];
  const upsertedCharacters: CharacterProfile[] = [];
  let broadcastSessionsCount = 0;
  const service = new CharacterRuntimeService({
    getCharacters: () => [createCharacter()],
    setCharacters() {},
    async listStoredCharacters() {
      return [createCharacter({ name: "Muse+" })];
    },
    async getStoredCharacter() {
      return createCharacter();
    },
    async createStoredCharacter(input: CreateCharacterInput) {
      return createCharacter({ id: "char-2", name: input.name });
    },
    async updateStoredCharacter(character) {
      return createCharacter(character);
    },
    async deleteStoredCharacter() {},
    listSessions: () => storedSessions,
    upsertStoredSession(session) {
      upsertedCharacters.push(createCharacter({
        id: session.characterId,
        name: session.character,
        iconPath: session.characterIconPath,
        themeColors: session.characterThemeColors,
      }));
      storedSessions.splice(0, storedSessions.length, session);
      return session;
    },
    reloadStoredSessions() {
      return [...storedSessions];
    },
    setSessions(nextSessions) {
      storedSessions.splice(0, storedSessions.length, ...nextSessions);
    },
    closeCharacterEditor() {},
    broadcastCharacters() {},
    broadcastSessions() {
      broadcastSessionsCount += 1;
    },
  });

  const updated = await service.updateCharacter(createCharacter({ name: "Muse+" }));

  assert.equal(updated.name, "Muse+");
  assert.equal(upsertedCharacters[0]?.name, "Muse+");
  assert.equal(storedSessions[0]?.character, "Muse+");
  assert.equal(broadcastSessionsCount, 1);
});

test("CharacterRuntimeService は delete 時に一覧更新と editor close を行う", async () => {
  const calls: string[] = [];
  const service = new CharacterRuntimeService({
    getCharacters: () => [createCharacter()],
    setCharacters(characters) {
      calls.push(`set:${characters.length}`);
    },
    async listStoredCharacters() {
      return [];
    },
    async getStoredCharacter() {
      return null;
    },
    async createStoredCharacter(input: CreateCharacterInput) {
      return createCharacter({ id: "char-2", name: input.name });
    },
    async updateStoredCharacter(character) {
      return character;
    },
    async deleteStoredCharacter(characterId) {
      calls.push(`delete:${characterId}`);
    },
    listSessions: () => [],
    upsertStoredSession(session) {
      return session;
    },
    reloadStoredSessions() {
      return [];
    },
    setSessions() {},
    closeCharacterEditor(characterId) {
      calls.push(`close:${characterId}`);
    },
    broadcastCharacters() {
      calls.push("broadcastCharacters");
    },
    broadcastSessions() {},
  });

  await service.deleteCharacter("char-1");

  assert.deepEqual(calls, [
    "delete:char-1",
    "set:0",
    "broadcastCharacters",
    "close:char-1",
  ]);
});
