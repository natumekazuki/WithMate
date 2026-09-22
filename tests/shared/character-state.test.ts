import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cloneCharacterProfiles,
  type CharacterProfile,
} from "../../src-shared/character/character-state.js";

function createCharacter(partial?: Partial<CharacterProfile>): CharacterProfile {
  return {
    id: "char-1",
    name: "Mia",
    description: "",
    iconPath: "icon.png",
    roleMarkdown: "role",
    notesMarkdown: "notes",
    updatedAt: "2026-03-29T00:00:00.000Z",
    themeColors: {
      main: "#111111",
      sub: "#222222",
    },
    ...partial,
  };
}

describe("character-state", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "cloneCharacterProfilesはcharacter profileの値を保持し、themeColorsをdeep cloneする"
  // oracle = { type = "contract", ref = "src-shared/character/character-state.ts#cloneCharacterProfiles" }
  // fault = "character profileの複製が元profileを共有するか、表示テーマの変更が元値へ伝播する"
  // observable = "cloneCharacterProfilesの値同一性とthemeColors参照分離"
  // observation_boundary = "public-boundary"
  // scope = "character-profile-clone"
  // lifecycle = "permanent"
  // impact = "character表示値またはテーマが別sessionの操作で汚染される"
  // distinction = "microcopy廃止後も有効なcharacter profile/themeのclone契約を確認する"
  // @end-test-value
  it("cloneCharacterProfiles は profile を保持して themeColors を deep clone する", () => {
    const source = [createCharacter()];
    const cloned = cloneCharacterProfiles(source);

    assert.deepEqual(cloned, source);
    assert.notEqual(cloned[0], source[0]);
    assert.notEqual(cloned[0]?.themeColors, source[0]?.themeColors);
  });
});
