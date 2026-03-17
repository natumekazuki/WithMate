# Character Storage

## Goal
WithMate 専用ディレクトリ配下でキャラクターデータを永続化し、Home / Character Editor / Session / Character Stream が共通で参照できる character catalog を提供する。

## Directory Policy
- キャラクターデータの正本は Codex 本体の `characters/` ではなく、WithMate 専用ディレクトリに置く。
- 保存先は Electron Main Process から `app.getPath("userData")` を基準に解決する。
- `userData` は `<appData>/WithMate/` へ固定する。
- 基本パスは `<userData>/characters/` とする。

## Directory Layout
```text
<userData>/
  characters/
    <character-id>/
      meta.json
      character.md
      character.png
```

## File Responsibilities
### `meta.json`
アプリが軽量に読む機械向け情報を持つ。

想定項目:
```json
{
  "id": "kuramochi-melto",
  "name": "倉持めると",
  "description": "Home 一覧用の短い説明",
  "theme": {
    "main": "#6f8cff",
    "sub": "#6fb8c7"
  },
  "iconFile": "character.png",
  "roleFile": "character.md",
  "createdAt": "2026-03-12T12:00:00.000Z",
  "updatedAt": "2026-03-12T12:00:00.000Z"
}
```

用途:
- Home の character list
- New Session の character picker
- Session header / avatar 表示
- Session の color theme snapshot 生成
- Editor の一覧取得

### `character.md`
キャラクターロール定義の正本。実行時 prompt 合成や Character Stream 生成で参照する。

詳細な合成ルールは `docs/design/prompt-composition.md` を参照する。

責務:
- 会話用ロール定義
- キャラクター性の本文
- system prompt 合成の主要入力
- 独り言の温度感や話し方の基準

非責務:
- 一覧表示専用の更新日時
- Editor の軽量表示用メタデータ
- 固定の実行制御指示
- 現行 Editor では `Role` 入力欄の本文をそのまま `character.md` へ保存する。

### `character.png`
Home / Session / Character Stream で使うアイコン画像の正本。

実装上は source image を character directory へコピーし、実際のファイル名は `meta.json` の `iconFile` を正本とする。
Renderer 側では browser 標準の file picker で画像を選び、保存時に Main Process へ渡す。

## Source Of Truth
- Character catalog の source of truth は file system 上の `meta.json + character.md + character.png`。
- Renderer は Main Process 経由で catalog を読む。
- Renderer が直接ディレクトリを走査しない。

## Main Process Responsibilities
Main Process は以下を担当する。

1. character root directory の解決
2. character directory 一覧の走査
3. `meta.json` とファイル存在確認による catalog 組み立て
4. character 作成時のディレクトリ生成
5. 編集時の `meta.json` / `character.md` / `character.png` 更新
6. 削除時の character directory 削除
7. Renderer 向けの安全な表示用パス返却

## Renderer Responsibilities
### Home
- character list を表示する
- `Add Character` と card 全体クリックによる編集導線を出す
- catalog の編集ロジック自体は持たない

### Character Editor
- 入力フォームを出す
- 保存時は Main Process API を呼ぶ
- ファイルシステム操作はしない
- image picker は browser 標準の file input を使う

### Session
- session に保存された `characterId` または snapshot metadata を使って avatar を表示する
- 実行時に必要なら Main Process から最新 character metadata を再取得する

## Data Model
最低限の catalog 返却型:
```ts
export type CharacterCatalogEntry = {
  id: string;
  name: string;
  iconPath: string;
  updatedAt: string;
};
```

Editor 用の詳細型:
```ts
export type CharacterDetail = {
  id: string;
  name: string;
  iconPath: string;
  roleMarkdown: string;
  updatedAt: string;
};
```

## Save Rules
- 新規作成時は `<character-id>/` を作成する。
- `character-id` は name から slug 化して作る。
- 同名衝突時は suffix を付与して回避する。
- 保存は `meta.json` と本文ファイルを同一操作として扱う。
- `character.png` 未設定時は placeholder ではなく空ファイルを作らず、icon なしとして扱う。
- 画像が指定された場合は source path から character directory 配下へコピーし、Renderer には保存後の絶対パスを返す。

## Delete Rules
- 削除は character directory 単位で行う。
- Home からは直接削除せず、Character Editor からのみ実行する。
- current 実装では、session が削除済み character を参照しているケースを完全には保護できていない。
- **確定方針 / 今後反映**:
  - character を解決できない session は新規 turn を続行しない。
  - ただし session 自体は削除せず、過去ログ / audit / diff を読むための `browse-only` / `view-only` 相当状態を許容する。
  - 同名 character の再作成時でも、`name` fallback で別 character へ自動再接続させない。

## Current Implementation と future 方針

- **current 実装**:
  - session 側に character snapshot が残るため、一覧表示は継続できる場合がある。
  - 一方で、元 character が消えていると turn 実行時に解決失敗する。
  - 文書上で想定していた `graceful degradation` は、まだ browse-only 仕様として実装完了していない。
- **確定方針 / future**:
  - `characterId` を正本とし、未解決時は `閲覧のみ可能 / 実行不可` として扱う。
  - `name` だけを使った再接続は行わない。
  - Home / Session では「過去の session 記録を読む導線」と「今後の実行可否」を分けて表現する。

## Migration Policy
- Electron 実行時は file-based storage を正本にする。
- character root が空でも、そのまま empty state を表示して新規作成を促す。

## Open Questions
- import/export をどの形式で扱うか
- Session が character snapshot をどこまで保持するか
