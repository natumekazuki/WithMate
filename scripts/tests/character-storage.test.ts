import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      assert.equal(mia.iconFilePath, path.join(userDataPath, "assets/my  icon.png"));
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

  it("createCharacter は外部 icon 画像を Character directory へコピーして表示可能 path を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.jpg");
      const sourceIconContent = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
      await writeFile(sourceIconPath, sourceIconContent);

      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({
        name: "Mia",
        iconFilePath: sourceIconPath,
        definitionMarkdown: validDefinition("Mia"),
      });
      const expectedIconPath = path.join(userDataPath, "characters", "mia", "icon.jpg");

      assert.equal(mia.iconFilePath, expectedIconPath);
      assert.equal(storage.getCharacter(mia.id)?.iconFilePath, expectedIconPath);
      assert.equal((await readFile(expectedIconPath)).equals(sourceIconContent), true);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT icon_file_path FROM characters WHERE id = ?").get(mia.id) as {
          icon_file_path: string;
        };
        assert.equal(row.icon_file_path, "characters/mia/icon.jpg");
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateCharacterMetadata は外部 icon 画像をコピーし、icon 未変更の保存で managed relative path を維持する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceIconContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
      await writeFile(sourceIconPath, sourceIconContent);

      const updated = storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceIconPath,
      });
      const expectedIconPath = path.join(userDataPath, "characters", "mia", "icon.png");

      assert.equal(updated.iconFilePath, expectedIconPath);
      assert.equal((await readFile(expectedIconPath)).equals(sourceIconContent), true);

      const renamed = storage.updateCharacterMetadata({
        characterId: mia.id,
        name: "Mia Prime",
      });

      assert.equal(renamed.iconFilePath, expectedIconPath);
      assert.equal((await readFile(expectedIconPath)).equals(sourceIconContent), true);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT icon_file_path FROM characters WHERE id = ?").get(mia.id) as {
          icon_file_path: string;
        };
        assert.equal(row.icon_file_path, "characters/mia/icon.png");
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateCharacterMetadata は managed icon 置換時に旧 icon ファイルを削除する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourcePngPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceJpgPath = path.join(path.dirname(userDataPath), "source-icon.jpg");
      const sourcePngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
      const sourceJpgContent = Buffer.from([0xff, 0xd8, 0xff, 0x02]);
      await writeFile(sourcePngPath, sourcePngContent);
      await writeFile(sourceJpgPath, sourceJpgContent);

      storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourcePngPath,
      });
      const oldIconPath = path.join(userDataPath, "characters", "mia", "icon.png");
      await access(oldIconPath);

      const updated = storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceJpgPath,
      });
      const nextIconPath = path.join(userDataPath, "characters", "mia", "icon.jpg");

      assert.equal(updated.iconFilePath, nextIconPath);
      assert.equal((await readFile(nextIconPath)).equals(sourceJpgContent), true);
      await assert.rejects(access(oldIconPath));
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("createCharacter は画像ではない絶対 icon path と大きすぎる icon を拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const textPath = path.join(path.dirname(userDataPath), "not-image.txt");
      const largePngPath = path.join(path.dirname(userDataPath), "large-icon.png");
      await writeFile(textPath, "not an image", "utf8");
      await writeFile(largePngPath, Buffer.alloc((10 * 1024 * 1024) + 1));

      assert.throws(
        () => storage.createCharacter({
          name: "Text Icon",
          iconFilePath: textPath,
          definitionMarkdown: validDefinition("Text Icon"),
        }),
        /png \/ jpg \/ jpeg \/ gif \/ webp \/ bmp \/ svg/,
      );
      assert.throws(
        () => storage.createCharacter({
          name: "Large Icon",
          iconFilePath: largePngPath,
          definitionMarkdown: validDefinition("Large Icon"),
        }),
        /10 MiB/,
      );
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
      const expectedIconPath = path.join(userDataPath, "assets/new  icon.png");
      assert.equal(updatedNoa.name, "Noa Prime");
      assert.equal(updatedNoa.description, "Updated");
      assert.equal(updatedNoa.iconFilePath, expectedIconPath);
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
      const sourceIconPath = path.join(path.dirname(userDataPath), "broken-icon.png");
      await writeFile(sourceIconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      assert.throws(
        () => storage.createCharacter({
          name: "Broken",
          iconFilePath: sourceIconPath,
          definitionMarkdown: "## Missing frontmatter",
        }),
        /missing_frontmatter/,
      );
      await assert.rejects(access(path.join(userDataPath, "characters", "broken")));

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
