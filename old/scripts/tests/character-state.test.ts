import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cloneCharacterProfiles,
  type CharacterProfile,
} from "../../src/character-state.js";

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
    sessionCopy: {
      pendingApproval: ["a"],
      pendingWorking: ["b"],
      pendingResponding: ["c"],
      pendingPreparing: ["d"],
      retryInterruptedTitle: ["e"],
      retryFailedTitle: ["f"],
      retryCanceledTitle: ["g"],
      latestCommandWaiting: ["h"],
      latestCommandEmpty: ["i"],
      changedFilesEmpty: ["j"],
      contextEmpty: ["k"],
    },
    ...partial,
  };
}

describe("character-state", () => {
  it("cloneCharacterProfiles は sessionCopy を保持して deep clone する", () => {
    const source = [createCharacter()];
    const cloned = cloneCharacterProfiles(source);

    assert.deepEqual(cloned, source);
    assert.notEqual(cloned[0], source[0]);
    assert.notEqual(cloned[0]?.themeColors, source[0]?.themeColors);
    assert.notEqual(cloned[0]?.sessionCopy, source[0]?.sessionCopy);
    assert.notEqual(cloned[0]?.sessionCopy.pendingApproval, source[0]?.sessionCopy.pendingApproval);
  });
});
