# Character Storage

- 作成日: 2026-03-12
- 更新日: 2026-06-14
- 対象: V5 Core の Character catalog / storage / snapshot 境界

## Goal

V5 Core では、SingleMate の `current` 固定ではなく、複数 Character を保存、列挙、取得、更新できる catalog boundary を提供する。

この文書は V5 Core の Character storage 正本である。current runtime の session / companion prompt injection は後続 branch で接続するが、Character 実装ではこの storage 境界を優先する。

## Scope

V5 Core に含める:

- SQLite 上の Character metadata
- `characters/<character-id>/character.md` file body
- optional `characters/<character-id>/character-notes.md`
- default Character selection
- archive
- session / companion snapshot 用 domain model
- renderer から Main Process 経由で使う IPC / preload API

V5 Core に含めない:

- `meta.json` 正本の file-only catalog
- Character 定義自動生成
- 詳細 Editor / section Editor
- Character Update Workspace
- provider instruction sync への Character 書き込み
- Memory / Growth / MateTalk 再設計

## Source Of Truth

| Data | Source of truth |
| --- | --- |
| catalog metadata | SQLite `characters` table |
| runtime definition body | `characters/<character-id>/character.md` |
| authoring notes | `characters/<character-id>/character-notes.md` |
| launch default | SQLite `characters.is_default` |
| session runtime input | session / companion 作成時に保存する `CharacterRuntimeSnapshot` |

Renderer は filesystem を直接走査しない。Character catalog は Main Process service 経由で取得する。

## Directory Layout

```text
<userData>/
  withmate-v4.db
  characters/
    <character-id>/
      character.md
      character-notes.md
```

V5 Core では `character.png` の実体コピーは必須にしない。icon は metadata の `iconFilePath` として扱い、画像 import / replace の詳細は Settings editor branch で扱う。

## SQLite Metadata

`characters` table:

| Column | Meaning |
| --- | --- |
| `id` | stable Character id |
| `name` | display name |
| `description` | list / picker 用の短い説明 |
| `icon_file_path` | optional icon file path |
| `theme_main` / `theme_sub` | UI theme color snapshot の元値 |
| `state` | `active` / `archived` |
| `is_default` | launch selector の default |
| `created_at` / `updated_at` / `archived_at` | lifecycle timestamps |

`is_default = 1` は active Character で最大 1 件にする。default Character を archive した場合は、残る active Character から fallback default を選ぶ。active Character が 0 件なら default なしを許容する。

既存 V4 DB への安全な追加にするため、`characters` table は V4 required table 判定には入れず、`CharacterStorage` 初期化時に `CREATE TABLE IF NOT EXISTS` で作成する。

## Files

### `character.md`

- V5 Character runtime definition の正本。
- format と validation は `docs/design/character-definition-format.md` に従う。
- storage / import / raw editor は schema、name、body、size、null byte、path safety を検証する。

### `character-notes.md`

- authoring notes / evidence / revision notes 用の補助ファイル。
- runtime prompt の常設入力にしない。
- V5 Core では null byte と size limit だけを検証する。

## Service API

V5 Core の storage service は次を提供する:

- `listCharacters({ includeArchived? })`
- `getCharacter(characterId)`
- `createCharacter(input)`
- `updateCharacterMetadata(input)`
- `updateCharacterDefinition(input)`
- `archiveCharacter(characterId)`
- `setDefaultCharacter(characterId)`
- `resolveLaunchCharacter({ characterId? })`
- `createRuntimeSnapshot(characterId)`

`resolveLaunchCharacter` は次の順で active Character を返す:

1. 明示された `characterId`
2. default Character
3. 更新日時順の active Character
4. `null`

Character 0 件時は `null` を返し、Home / launch branch 側で neutral fallback を維持する。

## Runtime Snapshot

`CharacterRuntimeSnapshot` は session / companion 作成時に保存する immutable input である。

最低限含める:

- `characterId`
- `name`
- `description`
- `iconFilePath`
- `theme`
- `definitionMarkdown`
- `definitionSha256`
- `definitionByteSize`
- `snapshotAt`

Runtime prompt injection は catalog 現在値ではなく saved snapshot を使う。実際の injection 接続は Branch 6 で扱う。

## Data Safety

- Character id は storage 側で生成し、path traversal を許さない。
- Renderer は `character.md` file path を直接指定しない。
- `character.md` の invalid update は metadata update と分離して拒否する。
- archive は directory を削除しない。過去 session snapshot と audit 参照を優先する。
- 同名 Character を再作成しても、過去 session を name fallback で自動再接続しない。
- app database reset / recreate では SQLite metadata と `characters/` file body を同時に削除する。DB だけを消して orphan `character.md` / `character-notes.md` を残さない。

## Related Docs

- `docs/design/character-definition-format.md`
- `docs/design/v5-character-transition.md`
- `docs/plans/20260613-v5-character-core-branches.md`
