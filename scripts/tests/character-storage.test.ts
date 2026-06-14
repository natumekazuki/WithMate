import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CharacterStorage } from "../../src-electron/character-storage.js";
import { CHARACTER_DEFINITION_SCHEMA } from "../../src/character/character-definition.js";

function validDefinition(name: string): string {
  return `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: "${name}"
description: ""
---

# Character Runtime Definition

## Identity
- ${name}
`;
}

async function createTempPaths(): Promise<{ dbPath: string; userDataPath: string; cleanup: () => Promise<void> }> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "withmate-character-storage-"));
  return {
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    userDataPath: path.join(tmpDir, "user-data"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("CharacterStorage", () => {
  it("複数 Character を作成し default / definition file / list を保持する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({
        name: "Mia",
        description: "First character",
        iconFilePath: "assets/my  icon.png",
        definitionMarkdown: validDefinition("Mia"),
        notesMarkdown: "# Character Notes\n",
      });
      const noa = storage.createCharacter({
        name: "Noa",
        definitionMarkdown: validDefinition("Noa"),
        theme: { main: "#112233", sub: "#445566" },
      });

      assert.equal(mia.id, "mia");
      assert.equal(mia.isDefault, true);
      assert.equal(mia.iconFilePath, "assets/my  icon.png");
      assert.equal(noa.isDefault, false);
      assert.deepEqual(storage.listCharacters().map((character) => character.id), ["mia", "noa"]);

      const definitionPath = path.join(userDataPath, "characters", "mia", "character.md");
      assert.match(await readFile(definitionPath, "utf8"), /name: "Mia"/);

      const detail = storage.getCharacter("noa");
      assert.equal(detail?.theme.main, "#112233");
      assert.match(detail?.definitionMarkdown ?? "", /name: "Noa"/);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("metadata / definition 更新、default 切替、archive fallback、launch 解決を扱う", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const noa = storage.createCharacter({ name: "Noa", definitionMarkdown: validDefinition("Noa") });

      const updatedNoa = storage.updateCharacterMetadata({
        characterId: noa.id,
        name: "Noa Prime",
        description: "Updated",
        iconFilePath: "assets/new  icon.png",
        theme: { main: "#abcdef" },
      });
      assert.equal(updatedNoa.name, "Noa Prime");
      assert.equal(updatedNoa.description, "Updated");
      assert.equal(updatedNoa.iconFilePath, "assets/new  icon.png");
      assert.equal(updatedNoa.theme.main, "#abcdef");

      const nextDefinition = validDefinition("Noa Prime").replace("- Noa Prime", "- Updated persona");
      assert.match(storage.updateCharacterDefinition({
        characterId: noa.id,
        definitionMarkdown: nextDefinition,
        notesMarkdown: "# Character Notes\n\n## Revision Notes\n- updated\n",
      }).definitionMarkdown, /Updated persona/);

      assert.equal(storage.setDefaultCharacter(noa.id).isDefault, true);
      assert.equal(storage.resolveLaunchCharacter({})?.id, noa.id);
      assert.equal(storage.resolveLaunchCharacter({ characterId: mia.id })?.id, mia.id);

      assert.equal(storage.archiveCharacter(noa.id).state, "archived");
      assert.equal(storage.resolveLaunchCharacter({ characterId: noa.id })?.id, mia.id);
      assert.deepEqual(storage.listCharacters().map((character) => character.id), [mia.id]);
      assert.deepEqual(storage.listCharacters({ includeArchived: true }).map((character) => character.id), [mia.id, noa.id]);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("invalid character.md を拒否し runtime snapshot を作成する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      assert.throws(
        () => storage.createCharacter({ name: "Broken", definitionMarkdown: "## Missing frontmatter" }),
        /missing_frontmatter/,
      );

      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const snapshot = storage.createRuntimeSnapshot(mia.id);

      assert.equal(snapshot?.characterId, mia.id);
      assert.equal(snapshot?.name, "Mia");
      assert.match(snapshot?.definitionSha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(snapshot?.definitionByteSize, Buffer.byteLength(validDefinition("Mia"), "utf8"));
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("deleteCharacterRootDirectory は file body を削除して root を再作成する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const definitionPath = path.join(userDataPath, "characters", mia.id, "character.md");
      await access(definitionPath);

      await storage.deleteCharacterRootDirectory();

      await assert.rejects(access(definitionPath));
      await access(path.join(userDataPath, "characters"));
    } finally {
      storage?.close();
      await cleanup();
    }
  });
});
