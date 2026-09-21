import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { CharacterStorage } from "../../src-electron/character-storage.js";
import { UNKNOWN_CHARACTER_OWNER_ID } from "../../src-shared/character/character-owner.js";
import {
  CHARACTER_DEFINITION_MAX_CHARACTERS,
  CHARACTER_DEFINITION_SCHEMA,
} from "../../src-shared/character/character-definition.js";

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
  // @test-value v2
  // kind = "contract"
  // claim = "Character の作成結果と定義ファイルを永続化し、一覧順と再読込結果を一致させる"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#listCharacters" }
  // fault = "非同期ファイル準備後のCharacter登録または再読込が欠落し、一覧・定義・メタデータが不一致になる"
  // observable = "createCharacter と getCharacter/listCharacters の結果および保存済みcharacter.md"
  // observation_boundary = "public-boundary"
  // scope = "character-storage-persistence"
  // lifecycle = "permanent"
  // impact = "Character作成後の起動・一覧表示で定義や更新順が失われる"
  // distinction = "SQL行だけでなく非同期body保存と再読込の契約を確認する"
  // @end-test-value
  it("複数 Character を作成し definition file / updated順のlistを保持する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({
        name: "Mia",
        description: "First character",
        iconFilePath: "assets/my  icon.png",
        definitionMarkdown: validDefinition("Mia"),
        notesMarkdown: "# Character Notes\n",
      });
      const noa = await storage.createCharacter({
        name: "Noa",
        definitionMarkdown: validDefinition("Noa"),
        theme: { main: "#112233", sub: "#445566" },
      });

      assert.equal(mia.id, "mia");
      assert.equal(mia.iconFilePath, path.join(userDataPath, "assets/my  icon.png"));
      assert.deepEqual(storage.listCharacters().map((character) => character.id), ["noa", "mia"]);

      const definitionPath = path.join(userDataPath, "characters", "mia", "character.md");
      assert.match(await readFile(definitionPath, "utf8"), /name: "Mia"/);

      const detail = await storage.getCharacter("noa");
      assert.equal(detail?.theme.main, "#112233");
      assert.match(detail?.definitionMarkdown ?? "", /name: "Noa"/);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "外部iconをCharacter管理領域へコピーし、公開pathとDB相対pathを一致させる"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#copyIconFromSourcePath" }
  // fault = "iconの非同期コピーが登録前後で欠落し、表示pathまたはDB参照が実体とずれる"
  // observable = "createCharacter のiconFilePath、コピー先bytes、characters.icon_file_path"
  // observation_boundary = "public-boundary"
  // scope = "character-icon-storage"
  // lifecycle = "permanent"
  // impact = "作成済みCharacterのiconが表示できない"
  // distinction = "外部sourceから管理領域へのコピーと公開pathの変換を確認する"
  // @end-test-value
  it("createCharacter は外部 icon 画像を Character directory へコピーして表示可能 path を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.jpg");
      const sourceIconContent = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
      await writeFile(sourceIconPath, sourceIconContent);

      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({
        name: "Mia",
        iconFilePath: sourceIconPath,
        definitionMarkdown: validDefinition("Mia"),
      });
      const expectedIconPath = path.join(userDataPath, "characters", "mia", "icon.jpg");

      assert.equal(mia.iconFilePath, expectedIconPath);
      assert.equal((await storage.getCharacter(mia.id))?.iconFilePath, expectedIconPath);
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

  // @test-value v2
  // kind = "contract"
  // claim = "metadata更新時のiconコピーと未変更保存でmanaged icon参照を維持する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#updateCharacterMetadata" }
  // fault = "metadata更新がicon参照を空値やsource pathへ変え、既存iconを失う"
  // observable = "更新後CharacterのiconFilePath、管理領域のbytes、DB相対path"
  // observation_boundary = "public-boundary"
  // scope = "character-metadata-icon"
  // lifecycle = "permanent"
  // impact = "設定更新だけでCharacter iconが壊れる"
  // distinction = "icon変更あり・なしの両方を同一公開メソッドで確認する"
  // @end-test-value
  it("updateCharacterMetadata は外部 icon 画像をコピーし、icon 未変更の保存で managed relative path を維持する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceIconContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
      await writeFile(sourceIconPath, sourceIconContent);

      const updated = await storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceIconPath,
      });
      const expectedIconPath = path.join(userDataPath, "characters", "mia", "icon.png");

      assert.equal(updated.iconFilePath, expectedIconPath);
      assert.equal((await readFile(expectedIconPath)).equals(sourceIconContent), true);

      const renamed = await storage.updateCharacterMetadata({
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

  // @test-value v2
  // kind = "invariant"
  // claim = "managed iconの置換後は新iconを保持し、旧managed fileを削除する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#cleanupReplacedManagedIcon" }
  // fault = "置換後に旧iconが残る、または新iconまで削除される"
  // observable = "新旧icon fileの存在と更新後のiconFilePath"
  // observation_boundary = "public-boundary"
  // scope = "character-icon-replacement"
  // lifecycle = "permanent"
  // impact = "不要なicon蓄積または表示不能が発生する"
  // distinction = "managed pathの置換cleanupだけを対象にする"
  // @end-test-value
  it("updateCharacterMetadata は managed icon 置換時に旧 icon ファイルを削除する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourcePngPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceJpgPath = path.join(path.dirname(userDataPath), "source-icon.jpg");
      const sourcePngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
      const sourceJpgContent = Buffer.from([0xff, 0xd8, 0xff, 0x02]);
      await writeFile(sourcePngPath, sourcePngContent);
      await writeFile(sourceJpgPath, sourceJpgContent);

      await storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourcePngPath,
      });
      const oldIconPath = path.join(userDataPath, "characters", "mia", "icon.png");
      await access(oldIconPath);

      const updated = await storage.updateCharacterMetadata({
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

  // @test-value v2
  // kind = "invariant"
  // claim = "同一managed iconを表すpath aliasではicon実体を削除しない"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#areCharacterIconPathReferencesEquivalent" }
  // fault = "path表記差だけの更新で現在iconを削除する"
  // observable = "alias更新後のicon file存在とbytes"
  // observation_boundary = "public-boundary"
  // scope = "character-icon-alias"
  // lifecycle = "permanent"
  // impact = "同一iconの再保存で表示が壊れる"
  // distinction = "異なるiconへの置換ではなく同一参照判定を確認する"
  // @end-test-value
  it("updateCharacterMetadata は managed icon の相対 path alias で同じファイルを削除しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceIconContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]);
      await writeFile(sourceIconPath, sourceIconContent);

      await storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceIconPath,
      });
      const managedIconPath = path.join(userDataPath, "characters", mia.id, "icon.png");

      const updated = await storage.updateCharacterMetadata({
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

  // @test-value v2
  // kind = "contract"
  // claim = "icon未指定・解除・不正型をmetadata更新契約どおりに区別する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#normalizeCharacterIconPathInput" }
  // fault = "未指定を解除として扱う、または不正型を保存して状態を壊す"
  // observable = "更新後iconFilePath、既存file、拒否されるError"
  // observation_boundary = "public-boundary"
  // scope = "character-icon-input"
  // lifecycle = "permanent"
  // impact = "icon設定の意図しない消失や不正データ保存が起きる"
  // distinction = "入力三状態の公開契約を個別に確認する"
  // @end-test-value
  it("updateCharacterMetadata は iconFilePath の未指定・解除・不正な runtime 型を区別する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const sourceIconPath = path.join(path.dirname(userDataPath), "source-icon.png");
      const sourceIconContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x04]);
      await writeFile(sourceIconPath, sourceIconContent);
      const before = await storage.updateCharacterMetadata({
        characterId: mia.id,
        iconFilePath: sourceIconPath,
      });
      const unchanged = await storage.updateCharacterMetadata({
        characterId: mia.id,
        name: "Mia Prime",
        iconFilePath: undefined,
      });
      assert.equal(unchanged.iconFilePath, before.iconFilePath);
      assert.equal((await readFile(before.iconFilePath)).equals(sourceIconContent), true);

      await assert.rejects(
        storage.updateCharacterMetadata({
          characterId: mia.id,
          name: "Mutated",
          iconFilePath: null as unknown as string,
        }),
        /Character icon path は文字列/,
      );

      const after = await storage.getCharacter(mia.id);
      assert.equal(after?.name, "Mia Prime");
      assert.equal(after?.iconFilePath, before.iconFilePath);
      assert.equal((await readFile(before.iconFilePath)).equals(sourceIconContent), true);

      const cleared = await storage.updateCharacterMetadata({
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

  // @test-value v2
  // kind = "contract"
  // claim = "Character icon入力の形式・実体・容量制約を作成前に検証する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#safeIconExtension" }
  // fault = "不正なiconを非同期準備またはSQL登録まで通して中途データを残す"
  // observable = "拒否ErrorとincludeArchived一覧が空であること"
  // observation_boundary = "public-boundary"
  // scope = "character-icon-validation"
  // lifecycle = "permanent"
  // impact = "表示不能なiconと壊れたCharacter行が保存される"
  // distinction = "拡張子・通常file・容量・path schemeの拒否をまとめて確認する"
  // @end-test-value
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

      await assert.rejects(
        storage.createCharacter({
          name: "Invalid Runtime Icon",
          iconFilePath: null as unknown as string,
          definitionMarkdown: validDefinition("Invalid Runtime Icon"),
        }),
        /Character icon path は文字列/,
      );
      await assert.rejects(
        storage.createCharacter({
          name: "Text Icon",
          iconFilePath: textPath,
          definitionMarkdown: validDefinition("Text Icon"),
        }),
        /png \/ jpg \/ jpeg/,
      );
      await assert.rejects(
        storage.createCharacter({
          name: "GIF Icon",
          iconFilePath: gifPath,
          definitionMarkdown: validDefinition("GIF Icon"),
        }),
        /png \/ jpg \/ jpeg/,
      );
      await assert.rejects(
        storage.createCharacter({
          name: "Relative WebP Icon",
          iconFilePath: "assets/icon.webp",
          definitionMarkdown: validDefinition("Relative WebP Icon"),
        }),
        /png \/ jpg \/ jpeg/,
      );
      await assert.rejects(
        storage.createCharacter({
          name: "File URL Icon",
          iconFilePath: "file:///C:/icons/icon.png",
          definitionMarkdown: validDefinition("File URL Icon"),
        }),
        /local file path/,
      );
      await assert.rejects(
        storage.createCharacter({
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

  // @test-value v2
  // kind = "invariant"
  // claim = "既存legacy iconは未変更更新で保持し、新規非対応iconへの差替えは拒否する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#updateCharacterMetadata" }
  // fault = "legacy参照を不必要に検証して壊す、または新規非対応iconを保存する"
  // observable = "legacy fileのbytes、更新後path、差替え拒否Error"
  // observation_boundary = "public-boundary"
  // scope = "character-legacy-icon"
  // lifecycle = "permanent"
  // impact = "既存Characterのicon互換性が失われるか不正iconが増える"
  // distinction = "既存値保持と新規入力検証を分離して確認する"
  // @end-test-value
  it("updateCharacterMetadata は既存の非対応 icon を未変更で保持できるが、新しい非対応 icon への差し替えは拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
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
      const updated = await storage.updateCharacterMetadata({
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
      await assert.rejects(
        storage.updateCharacterMetadata({
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

  // @test-value v2
  // kind = "invariant"
  // claim = "icon schemeとPOSIX pathをWindows pathとして誤正規化せず検証する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#normalizeCharacterIconPathInput" }
  // fault = "異なるschemeや非対応pathを同一managed fileとして扱う"
  // observable = "同一data URI更新の保持と不正path更新の拒否"
  // observation_boundary = "public-boundary"
  // scope = "character-icon-path-normalization"
  // lifecycle = "permanent"
  // impact = "icon参照の誤削除または不正path保存が起きる"
  // distinction = "scheme保持とPOSIX path拡張子検証の境界を確認する"
  // @end-test-value
  it("既存 icon の同一参照判定は scheme と POSIX path を Windows path として正規化しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE characters SET icon_file_path = ? WHERE id = ?")
          .run("data:image/webp;base64,AAAA", mia.id);
        assert.equal(
          (await storage.updateCharacterMetadata({
            characterId: mia.id,
            iconFilePath: "data:image/webp;base64,AAAA",
          })).iconFilePath,
          "data:image/webp;base64,AAAA",
        );
        await assert.rejects(
          storage.updateCharacterMetadata({
            characterId: mia.id,
            iconFilePath: "DATA:image/webp;base64,AAAA",
          }),
          /local file path/,
        );

        db.prepare("UPDATE characters SET icon_file_path = ? WHERE id = ?")
          .run("/legacy/muse/icon.webp", mia.id);
        await assert.rejects(
          storage.updateCharacterMetadata({
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

  // @test-value v2
  // kind = "contract"
  // claim = "legacy default metadataに依存せず明示されたactive Characterだけをlaunch解決する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#resolveLaunchCharacter" }
  // fault = "legacy default行やarchived Characterを起動対象として返す"
  // observable = "resolveLaunchCharacter結果、archive後のstate、一覧"
  // observation_boundary = "public-boundary"
  // scope = "character-launch-resolution"
  // lifecycle = "permanent"
  // impact = "起動時に意図しないCharacterが選択される"
  // distinction = "明示id解決とlegacy default列の非参照を同時に確認する"
  // @end-test-value
  it("legacy default metadataを参照・更新せず、明示Characterだけlaunch解決する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;
    let db: DatabaseSync | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const noa = await storage.createCharacter({ name: "Noa", definitionMarkdown: validDefinition("Noa") });

      const updatedNoa = await storage.updateCharacterMetadata({
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
      assert.match((await storage.updateCharacterDefinition({
        characterId: noa.id,
        definitionMarkdown: nextDefinition,
        notesMarkdown: "# Character Notes\n\n## Revision Notes\n- updated\n",
      })).definitionMarkdown, /Updated persona/);

      db = new DatabaseSync(dbPath);
      db.prepare("UPDATE characters SET is_default = 1 WHERE id = ?").run(mia.id);

      const yui = await storage.createCharacter({ name: "Yui", definitionMarkdown: validDefinition("Yui") });
      assert.deepEqual(
        (db.prepare("SELECT id, is_default FROM characters ORDER BY id").all() as Array<{ id: string; is_default: number }>)
          .map((row) => ({ ...row })),
        [
          { id: mia.id, is_default: 1 },
          { id: noa.id, is_default: 0 },
          { id: yui.id, is_default: 0 },
        ],
      );
      assert.equal(await storage.resolveLaunchCharacter({}), null);
      assert.equal((await storage.resolveLaunchCharacter({ characterId: mia.id }))?.id, mia.id);

      assert.equal((await storage.archiveCharacter(mia.id)).state, "archived");
      assert.equal(await storage.resolveLaunchCharacter({ characterId: mia.id }), null);
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

  // @test-value v2
  // kind = "contract"
  // claim = "character.mdのschema・サイズ検証を作成、更新、runtime snapshotで一貫して適用する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#writeDefinitionFiles" }
  // fault = "不正または過大なdefinitionを保存し、snapshotが壊れた定義を返す"
  // observable = "作成・更新の拒否Error、body cleanup、snapshotのnull"
  // observation_boundary = "public-boundary"
  // scope = "character-definition-validation"
  // lifecycle = "permanent"
  // impact = "不正なcharacter定義が永続化されruntimeへ流れる"
  // distinction = "保存時検証と既存body破損時のsnapshot拒否を確認する"
  // @end-test-value
  it("invalid または 8,000 文字超過の character.md を保存・runtime snapshot で拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const sourceIconPath = path.join(path.dirname(userDataPath), "broken-icon.png");
      await writeFile(sourceIconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await assert.rejects(
        storage.createCharacter({
          name: "Broken",
          iconFilePath: sourceIconPath,
          definitionMarkdown: "## Missing frontmatter",
        }),
        /missing_frontmatter/,
      );
      await assert.rejects(access(path.join(userDataPath, "characters", "broken")));

      const oversizedDefinition = `${validDefinition("Too Long")}${"あ".repeat(CHARACTER_DEFINITION_MAX_CHARACTERS)}`;
      await assert.rejects(
        storage.createCharacter({
          name: "Too Long",
          definitionMarkdown: oversizedDefinition,
        }),
        /size_limit_exceeded/,
      );
      await assert.rejects(access(path.join(userDataPath, "characters", "too-long")));

      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      const snapshot = await storage.createRuntimeSnapshot(mia.id);

      assert.equal(snapshot?.characterId, mia.id);
      assert.equal(snapshot?.name, "Mia");
      assert.match(snapshot?.definitionSha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(snapshot?.definitionByteSize, Buffer.byteLength(validDefinition("Mia"), "utf8"));

      await writeFile(
        path.join(userDataPath, "characters", mia.id, "character.md"),
        "## Missing frontmatter",
        "utf8",
      );
      assert.equal(await storage.createRuntimeSnapshot(mia.id), null);
      await writeFile(
        path.join(userDataPath, "characters", mia.id, "character.md"),
        validDefinition("Mia"),
        "utf8",
      );

      await assert.rejects(
        storage.updateCharacterDefinition({
          characterId: mia.id,
          definitionMarkdown: oversizedDefinition,
        }),
        /size_limit_exceeded/,
      );
      assert.equal((await storage.getCharacter(mia.id))?.definitionMarkdown, validDefinition("Mia"));

      await writeFile(
        path.join(userDataPath, "characters", mia.id, "character.md"),
        oversizedDefinition,
        "utf8",
      );
      assert.equal(await storage.createRuntimeSnapshot(mia.id), null);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "予約owner IDを生成Character IDとして再利用せずruntime snapshotも解決しない"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#createRuntimeSnapshot" }
  // fault = "予約ownerと通常CharacterのIDが衝突し、runtime stateを誤って返す"
  // observable = "生成idと予約idの差異、両者のsnapshot結果"
  // observation_boundary = "public-boundary"
  // scope = "character-owner-boundary"
  // lifecycle = "permanent"
  // impact = "unknown ownerのruntimeが別Characterへ誤接続する"
  // distinction = "生成idの予約値回避とsnapshot拒否を確認する"
  // @end-test-value
  it("予約 owner ID は生成 Character ID と衝突せず runtime snapshot を解決しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const formerlyColliding = await storage.createCharacter({
        name: "Unknown Character",
        definitionMarkdown: validDefinition("Unknown Character"),
      });

      assert.equal(formerlyColliding.id, "unknown-character");
      assert.notEqual(formerlyColliding.id, UNKNOWN_CHARACTER_OWNER_ID);
      assert.equal((await storage.createRuntimeSnapshot(formerlyColliding.id))?.characterId, formerlyColliding.id);
      assert.equal(await storage.createRuntimeSnapshot(UNKNOWN_CHARACTER_OWNER_ID), null);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "definition bodyが欠落したCharacterをruntime snapshot対象外として扱う"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#createRuntimeSnapshot" }
  // fault = "欠落bodyを例外なく不正snapshotとして返す、またはDB catalogまで失う"
  // observable = "snapshot nullとcatalog entryのstate/name"
  // observation_boundary = "public-boundary"
  // scope = "character-runtime-snapshot"
  // lifecycle = "permanent"
  // impact = "runtime起動時に定義なしCharacterが実行される"
  // distinction = "file bodyの欠落とSQL catalog保持を別々に確認する"
  // @end-test-value
  it("character.md が欠落した Character は runtime snapshot なしとして扱う", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
      await rm(path.join(userDataPath, "characters", mia.id, "character.md"));

      assert.equal(await storage.createRuntimeSnapshot(mia.id), null);
      assert.deepEqual(
        { name: storage.getCharacterCatalogEntry(mia.id)?.name, state: storage.getCharacterCatalogEntry(mia.id)?.state },
        { name: "Mia", state: "active" },
      );
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Character root削除後にfile bodyを除去しroot directoryを再作成する"
  // oracle = { type = "contract", ref = "src-electron/character-storage.ts#deleteCharacterRootDirectory" }
  // fault = "削除後rootがなくなり次回保存が失敗する、またはbodyが残る"
  // observable = "definition fileの不在とcharacters rootの存在"
  // observation_boundary = "public-boundary"
  // scope = "character-root-lifecycle"
  // lifecycle = "permanent"
  // impact = "character storage reset後の作成・保存が動かない"
  // distinction = "root lifecycleの公開reset契約だけを確認する"
  // @end-test-value
  it("deleteCharacterRootDirectory は file body を削除して root を再作成する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: CharacterStorage | null = null;

    try {
      storage = new CharacterStorage(dbPath, userDataPath);
      const mia = await storage.createCharacter({ name: "Mia", definitionMarkdown: validDefinition("Mia") });
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
