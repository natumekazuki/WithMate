# Character Storage

- 作成日: 2026-03-12
- 更新日: 2026-06-15
- 対象: V5 Core の Character catalog / storage / snapshot 境界

## Goal

V5 Core では、SingleMate の `current` 固定ではなく、複数 Character を保存、列挙、取得、更新できる catalog boundary を提供する。

この文書は V5 Core の Character storage 正本である。current runtime の session / companion prompt injection は後続 branch で接続するが、Character 実装ではこの storage 境界を優先する。

## Scope

V5 Core に含める:

- SQLite 上の Character metadata
- `characters/<character-id>/character.md` file body
- optional `characters/<character-id>/character-notes.md`
- optional managed icon file `characters/<character-id>/icon.<ext>`
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
| managed icon body | `characters/<character-id>/icon.<ext>` |
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
      icon.<ext>
```

Character icon は保存時に Main Process が app data 配下へ materialize する。

- 外部絶対 path が指定された場合、`characters/<character-id>/icon.<ext>` へコピーする。
- DB の `icon_file_path` は managed icon では `characters/<character-id>/icon.<ext>` の app data 相対 path を保存する。
- API / renderer へ返す `iconFilePath` は `userData` 基準の表示可能な path に materialize する。
- 相対 path は `userData` 基準として扱う。`data:` / `file://` などの scheme path はコピーせず、そのまま返す。
- managed icon の許可拡張子は `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg` とし、絶対 path から取り込む場合は regular file かつ 10 MiB 以下であることを Main Process 側で検証する。
- managed icon を別拡張子へ置換した場合は、旧 `icon.<ext>` を best-effort で削除する。削除失敗は保存成功を妨げない。

## SQLite Metadata

`characters` table:

| Column | Meaning |
| --- | --- |
| `id` | stable Character id |
| `name` | display name |
| `description` | list / picker 用の短い説明 |
| `icon_file_path` | optional icon path。managed icon は `characters/<character-id>/icon.<ext>` の app data 相対 path |
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

### `icon.<ext>`

- Character 一覧、Editor preview、session / companion snapshot の avatar 表示に使う代表画像。
- Renderer は filesystem を直接解決せず、storage service が materialize した `iconFilePath` を受け取る。
- 外部絶対 path の取り込みは保存時にコピーし、保存後の正本は app data 配下の managed icon とする。

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
- Character 作成中に icon コピー後の validation / DB update が失敗した場合は、作成中の `characters/<character-id>/` directory を削除する。
- Character metadata 更新で managed icon を置換した場合は旧 icon file を best-effort で削除する。削除に失敗しても DB は新しい icon を指し、保存全体は失敗させない。
- archive は directory を削除しない。過去 session snapshot と audit 参照を優先する。
- 同名 Character を再作成しても、過去 session を name fallback で自動再接続しない。
- app database reset / recreate では SQLite metadata と `characters/` file body を同時に削除する。DB だけを消して orphan `character.md` / `character-notes.md` / `icon.<ext>` を残さない。

## Related Docs

- `docs/design/character-definition-format.md`
- `docs/design/v5-character-transition.md`
- `docs/plans/20260613-v5-character-core-branches.md`
