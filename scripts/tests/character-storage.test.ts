import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { CharacterStorage } from "../../src-electron/character-storage.js";
import { UNKNOWN_CHARACTER_OWNER_ID } from "../../src/character/character-owner.js";
import {
  CHARACTER_DEFINITION_MAX_CHARACTERS,
  CHARACTER_DEFINITION_SCHEMA,
} from "../../src/character/character-definition.js";

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
  it("複数 Character を作成し definition file / updated順のlistを保持する", async () => {
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
      assert.equal(mia.iconFilePath, path.join(userDataPath, "assets/my  icon.png"));
      assert.deepEqual(storage.listCharacters().map((character) => character.id), ["noa", "mia"]);

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

  it("updateCharacterMetadata は managed icon の相対 path alias で同じファイルを削除しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceIconContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]);
      await writeFile(sourceIconPath, sourceIconContent);

      storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceIconPath,
      });
      const managedIconPath = path.join(userDataPath, "characters", mia.id, "icon.png");

      const updated = storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: process.platform === "win32"
          ? `CHARACTERS/${mia.id.toUpperCase()}/./ICON.PNG`
          : `characters/${mia.id}/./icon.png`,
      });

      await access(updated.iconFilePath);
      assert.equal((await readFile(managedIconPath)).equals(sourceIconContent), true);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateCharacterMetadata は iconFilePath の未指定・解除・不正な runtime 型を区別する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceIconContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x04]);
      await writeFile(sourceIconPath, sourceIconContent);
      const before = storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceIconPath,
      });
      const unchanged = storage.updateCharacterMetadata({
        characterId: mia.id,
        name: "Mia Prime",
        iconFilePath: undefined,
      });
      assert.equal(unchanged.iconFilePath, before.iconFilePath);
      assert.equal((await readFile(before.iconFilePath)).equals(sourceIconContent), true);

      assert.throws(
        () => storage.updateCharacterMetadata({
          characterId: mia.id,
          name: "Mutated",
          iconFilePath: null as unknown as string,
        }),
        /Character icon path は文字列/,
      );

      const after = storage.getCharacter(mia.id);
      assert.equal(after?.name, "Mia Prime");
      assert.equal(after?.iconFilePath, before.iconFilePath);
      assert.equal((await readFile(before.iconFilePath)).equals(sourceIconContent), true);

      const cleared = storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: "",
      });
      assert.equal(cleared.iconFilePath, "");
      await assert.rejects(access(before.iconFilePath));
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("createCharacter は PNG / JPEG 以外、画像ではない path、大きすぎる icon を拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const textPath = path.join(path.dirname(userDataPath), "not-image.txt");
      const gifPath = path.join(path.dirname(userDataPath), "legacy-icon.gif");
      const largePngPath = path.join(path.dirname(userDataPath), "large-icon.png");
      await writeFile(textPath, "not an image", "utf8");
      await writeFile(gifPath, Buffer.from("GIF89a", "ascii"));
      await writeFile(largePngPath, Buffer.alloc((10 * 1024 * 1024) + 1));

      assert.throws(
        () => storage.createCharacter({
          name: "Invalid Runtime Icon",
          iconFilePath: null as unknown as string,
          definitionMarkdown: validDefinition("Invalid Runtime Icon"),
        }),
        /Character icon path は文字列/,
      );
      assert.throws(
        () => storage.createCharacter({
          name: "Text Icon",
          iconFilePath: textPath,
          definitionMarkdown: validDefinition("Text Icon"),
        }),
        /png \/ jpg \/ jpeg/,
      );
      assert.throws(
        () => storage.createCharacter({
          name: "GIF Icon",
          iconFilePath: gifPath,
          definitionMarkdown: validDefinition("GIF Icon"),
        }),
        /png \/ jpg \/ jpeg/,
      );
      assert.throws(
        () => storage.createCharacter({
          name: "Relative WebP Icon",
          iconFilePath: "assets/icon.webp",
          definitionMarkdown: validDefinition("Relative WebP Icon"),
        }),
        /png \/ jpg \/ jpeg/,
      );
      assert.throws(
        () => storage.createCharacter({
          name: "File URL Icon",
          iconFilePath: "file:///C:/icons/icon.png",
          definitionMarkdown: validDefinition("File URL Icon"),
        }),
        /local file path/,
      );
      assert.throws(
        () => storage.createCharacter({
          name: "Large Icon",
          iconFilePath: largePngPath,
          definitionMarkdown: validDefinition("Large Icon"),
        }),
        /10 MiB/,
      );
      assert.equal(storage.listCharacters({ includeArchived: true }).length, 0);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateCharacterMetadata は既存の非対応 icon を未変更で保持できるが、新しい非対応 icon への差し替えは拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const legacyIconPath = path.join(userDataPath, "characters", mia.id, "icon.webp");
      await writeFile(legacyIconPath, Buffer.from("legacy webp"));

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE characters SET icon_file_path = ? WHERE id = ?")
          .run(`characters/${mia.id}/icon.webp`, mia.id);
      } finally {
        db.close();
      }

      const differentlyFormattedWindowsPath = legacyIconPath
        .replaceAll("\\", "/")
        .replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
        .replace("/characters/", "/CHARACTERS/")
        .replace("/icon.webp", "/ICON.WEBP");
      const updated = storage.updateCharacterMetadata({
        characterId: mia.id,
        name: "Mia Prime",
        iconFilePath: process.platform === "win32"
          ? differentlyFormattedWindowsPath
          : legacyIconPath,
      });

      assert.equal(updated.name, "Mia Prime");
      assert.equal(updated.iconFilePath, legacyIconPath);
      assert.equal((await readFile(legacyIconPath, "utf8")), "legacy webp");

      const replacementPath = path.join(path.dirname(userDataPath), "replacement.gif");
      await writeFile(replacementPath, Buffer.from("GIF89a", "ascii"));
      assert.throws(
        () => storage.updateCharacterMetadata({
          characterId: mia.id,
          iconFilePath: replacementPath,
        }),
        /png \/ jpg \/ jpeg/,
      );
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("既存 icon の同一参照判定は scheme と POSIX path を Windows path として正規化しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE characters SET icon_file_path = ? WHERE id = ?")
          .run("data:image/webp;base64,AAAA", mia.id);
        assert.equal(
          storage.updateCharacterMetadata({
            characterId: mia.id,
            iconFilePath: "data:image/webp;base64,AAAA",
          }).iconFilePath,
          "data:image/webp;base64,AAAA",
        );
        assert.throws(
          () => storage.updateCharacterMetadata({
            characterId: mia.id,
            iconFilePath: "DATA:image/webp;base64,AAAA",
          }),
          /local file path/,
        );

        db.prepare("UPDATE characters SET icon_file_path = ? WHERE id = ?")
          .run("/legacy/muse/icon.webp", mia.id);
        assert.throws(
          () => storage.updateCharacterMetadata({
            characterId: mia.id,
            iconFilePath: "/legacy/muse\\icon.webp",
          }),
          /png \/ jpg \/ jpeg/,
        );
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("legacy default metadataを参照・更新せず、明示Characterだけlaunch解決する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;
    let db: DatabaseSync | null = null;

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

      db = new DatabaseSync(dbPath);
      db.prepare("UPDATE characters SET is_default = 1 WHERE id = ?").run(mia.id);

      const yui = storage.createCharacter({ name: "Yui", definitionMarkdown: validDefinition("Yui") });
      assert.deepEqual(
        (db.prepare("SELECT id, is_default FROM characters ORDER BY id").all() as Array<{ id: string; is_default: number }>)
          .map((row) => ({ ...row })),
        [
          { id: mia.id, is_default: 1 },
          { id: noa.id, is_default: 0 },
          { id: yui.id, is_default: 0 },
        ],
      );
      assert.equal(storage.resolveLaunchCharacter({}), null);
      assert.equal(storage.resolveLaunchCharacter({ characterId: mia.id })?.id, mia.id);

      assert.equal(storage.archiveCharacter(mia.id).state, "archived");
      assert.equal(storage.resolveLaunchCharacter({ characterId: mia.id }), null);
      assert.equal(
        (db.prepare("SELECT is_default FROM characters WHERE id = ?").get(mia.id) as { is_default: number }).is_default,
        1,
      );
      assert.deepEqual(storage.listCharacters().map((character) => character.id), [yui.id, noa.id]);
    } finally {
      db?.close();
      storage?.close();
      await cleanup();
    }
  });

  it("invalid または 8,000 文字超過の character.md を保存・runtime snapshot で拒否する", async () => {
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

      const oversizedDefinition = `${validDefinition("Too Long")}${"あ".repeat(CHARACTER_DEFINITION_MAX_CHARACTERS)}`;
      assert.throws(
        () => storage.createCharacter({
          name: "Too Long",
          definitionMarkdown: oversizedDefinition,
        }),
        /size_limit_exceeded/,
      );
      await assert.rejects(access(path.join(userDataPath, "characters", "too-long")));

      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const snapshot = storage.createRuntimeSnapshot(mia.id);

      assert.equal(snapshot?.characterId, mia.id);
      assert.equal(snapshot?.name, "Mia");
      assert.match(snapshot?.definitionSha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(snapshot?.definitionByteSize, Buffer.byteLength(validDefinition("Mia"), "utf8"));

      assert.throws(
        () => storage.updateCharacterDefinition({
          characterId: mia.id,
          definitionMarkdown: oversizedDefinition,
        }),
        /size_limit_exceeded/,
      );
      assert.equal(storage.getCharacter(mia.id)?.definitionMarkdown, validDefinition("Mia"));

      await writeFile(
        path.join(userDataPath, "characters", mia.id, "character.md"),
        oversizedDefinition,
        "utf8",
      );
      assert.equal(storage.createRuntimeSnapshot(mia.id), null);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("予約 owner ID は生成 Character ID と衝突せず runtime snapshot を解決しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const formerlyColliding = storage.createCharacter({
        name: "Unknown Character",
        definitionMarkdown: validDefinition("Unknown Character"),
      });

      assert.equal(formerlyColliding.id, "unknown-character");
      assert.notEqual(formerlyColliding.id, UNKNOWN_CHARACTER_OWNER_ID);
      assert.equal(storage.createRuntimeSnapshot(formerlyColliding.id)?.characterId, formerlyColliding.id);
      assert.equal(storage.createRuntimeSnapshot(UNKNOWN_CHARACTER_OWNER_ID), null);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("character.md が欠落した Character は runtime snapshot なしとして扱う", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      await rm(path.join(userDataPath, "characters", mia.id, "character.md"));

      assert.equal(storage.createRuntimeSnapshot(mia.id), null);
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
