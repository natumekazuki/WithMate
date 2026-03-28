import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterProfile } from "../../src/app-state.js";
import { buildHomeCharacterProjection } from "../../src/home-character-projection.js";

function createCharacter(partial: Partial<CharacterProfile> & Pick<CharacterProfile, "id" | "name">): CharacterProfile {
  return {
    description: "",
    iconPath: "icon.png",
    roleMarkdown: "",
    themeColors: {
      main: "#000000",
      sub: "#ffffff",
    },
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
    ...partial,
  };
}

describe("home-character-projection", () => {
  it("search text で filteredCharacters を返す", () => {
    const projection = buildHomeCharacterProjection(
      [
        createCharacter({ id: "a", name: "Mia", description: "azure" }),
        createCharacter({ id: "b", name: "Luna", description: "moon" }),
      ],
      "lu",
    );

    assert.deepEqual(projection.filteredCharacters.map((character) => character.id), ["b"]);
    assert.equal(projection.emptyState, null);
  });

  it("search に一致しない時は no-match を返す", () => {
    const projection = buildHomeCharacterProjection([createCharacter({ id: "a", name: "Mia" })], "zzz");

    assert.equal(projection.emptyState, "no-match");
  });

  it("character が無い時は empty を返す", () => {
    const projection = buildHomeCharacterProjection([], "");

    assert.equal(projection.emptyState, "empty");
  });
});
