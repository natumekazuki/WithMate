import assert from "node:assert/strict";
import test from "node:test";

import { MainCharacterFacade } from "../../src-electron/main-character-facade.js";

test("MainCharacterFacade は query/runtime service を束ねる", async () => {
  const calls: string[] = [];
  const facade = new MainCharacterFacade({
    getMainQueryService: () =>
      ({
        listCharacters() {
          calls.push("list");
          return [{ id: "c-1" }];
        },
        async refreshCharactersFromStorage() {
          calls.push("refresh");
          return [{ id: "c-1" }];
        },
        async getCharacter(characterId) {
          calls.push(`get:${characterId}`);
          return { id: characterId };
        },
      }) as never,
    getCharacterRuntimeService: () =>
      ({
        async createCharacter(input) {
          calls.push(`create:${input.name}`);
          return { id: "c-1", name: input.name };
        },
        async updateCharacter(character) {
          calls.push(`update:${character.id}`);
          return character;
        },
        async deleteCharacter(characterId) {
          calls.push(`delete:${characterId}`);
        },
        async resolveSessionCharacter(session) {
          calls.push(`resolve:${session.id}`);
          return { id: session.characterId };
        },
      }) as never,
  });

  assert.equal(facade.listCharacters().length, 1);
  await facade.refreshCharactersFromStorage();
  await facade.getCharacter("c-1");
  await facade.createCharacter({ name: "Alice" } as never);
  await facade.updateCharacter({ id: "c-1" } as never);
  await facade.deleteCharacter("c-1");
  const resolved = await facade.resolveSessionCharacter({ id: "s-1", characterId: "c-1" } as never);

  assert.equal(resolved?.id, "c-1");
  assert.deepEqual(calls, [
    "list",
    "refresh",
    "get:c-1",
    "create:Alice",
    "update:c-1",
    "delete:c-1",
    "resolve:s-1",
  ]);
});
