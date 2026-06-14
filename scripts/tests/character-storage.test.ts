import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function buildStoredZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.byteLength, 18);
    localHeader.writeUInt32LE(data.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.byteLength, 20);
    centralHeader.writeUInt32LE(data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt32LE(0, 34);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function corruptFirstCentralDirectoryUncompressedSize(zipBuffer: Buffer, size: number): Buffer {
  const copy = Buffer.from(zipBuffer);
  const localHeaderLength = 30 + Buffer.from("sophia/character.md", "utf8").byteLength + Buffer.byteLength(validDefinition("Sophia"), "utf8");
  copy.writeUInt32LE(size, localHeaderLength + 24);
  return copy;
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

  it("importCharacterPackFile は character.md / notes / icon asset を取り込む", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const zipPath = path.join(userDataPath, "sophia-pack.zip");
      await writeFile(zipPath, buildStoredZip([
        {
          name: "sophia/character.md",
          data: validDefinition("Sophia").replace('description: ""', 'description: "Spy style"'),
        },
        { name: "sophia/character-notes.md", data: "# Character Notes\n\n- source memo\n" },
        { name: "sophia/README.md", data: "# Pack README\n\nImport note.\n" },
        { name: "sophia/assets/icon.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]));

      const result = storage.importCharacterPackFile(zipPath);

      assert.equal(result.character.name, "Sophia");
      assert.equal(result.character.description, "Spy style");
      assert.match(result.character.notesMarkdown, /source memo/);
      assert.match(result.character.notesMarkdown, /Imported Pack README/);
      assert.equal(result.importedFiles.includes("sophia/character.md"), true);
      assert.match(result.character.iconFilePath, /characters[\\/]+sophia[\\/]+assets[\\/]+icon\.png$/);
      assert.deepEqual(await readFile(result.character.iconFilePath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("importCharacterPackFile は zip entry size 不一致を拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const zipPath = path.join(userDataPath, "broken-pack.zip");
      const zipBuffer = buildStoredZip([
        { name: "sophia/character.md", data: validDefinition("Sophia") },
      ]);
      await writeFile(zipPath, corruptFirstCentralDirectoryUncompressedSize(zipBuffer, 1));

      assert.throws(
        () => storage?.importCharacterPackFile(zipPath),
        /entry size が一致しません/,
      );
      assert.deepEqual(storage.listCharacters(), []);
    } finally {
      storage?.close();
      await cleanup();
    }
  });
});
