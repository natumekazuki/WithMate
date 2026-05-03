# Character Storage

> 4.0.0 note:
> WithMate 4.0.0 は完全 SingleMate とし、runtime の正本は `docs/design/single-mate-architecture.md` の Mate Profile へ移す。
> この文書は 3.x の character catalog と character update workspace の supporting / legacy detail として扱う。
> 4.0.0 では既存 character catalog から Mate への自動 migration は行わず、初回利用時に新しい Mate 作成から開始する。

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
      character-notes.md
      character.png
      AGENTS.md
      copilot-instructions.md
      skills/
        character-definition-update/
          SKILL.md
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
標準構成は `docs/design/character-definition-format.md` を参照する。

責務:
- 会話用ロール定義
- キャラクター性の本文
- 実行時 prompt 合成の主要入力
- 独り言の温度感や話し方の基準

非責務:
- 一覧表示専用の更新日時
- Editor の軽量表示用メタデータ
- 固定の実行制御指示
- 調査メモ、採用理由、改稿履歴
- 現行 Editor では `Role` 入力欄の本文をそのまま `character.md` へ保存する。

### `character-notes.md`
調査メモ、採用理由、出典、未確定事項、改稿履歴を持つ補助ファイル。

責務:
- 調査結果の蓄積
- 採用しなかった解釈の退避
- 次回更新時の引き継ぎ

非責務:
- prompt 合成の直接入力
- Home 一覧表示用 metadata

補足:
- current 実装では character 保存時に seed される
- Character Editor の `character-notes` タブから編集できる
- 標準構成は `docs/design/character-definition-format.md` を参照する

### `character.png`
Home / Session / Character Stream で使うアイコン画像の正本。

実装上は source image を character directory へコピーし、実際のファイル名は `meta.json` の `iconFile` を正本とする。
Renderer 側では browser 標準の file picker で画像を選び、保存時に Main Process へ渡す。

補足:
- Character Update workflow では paired asset として扱う
- current 実装では workspace 内に `character.png` がある場合、表示時はそれを優先して使う

### `AGENTS.md` / `copilot-instructions.md`
character 保存時に character directory へ同期する update 用 instruction file。  
Character Update Workspace 起動前から存在し、初期作成直後でもそのまま update workspace として使える状態にする。

責務:
- workspace 内の fixed skill を前提に使うことを明示する
- `character.md` と `character-notes.md` の役割を短く示す
- prompt にどう入るかを短く示す

非責務:
- character catalog の一覧表示
- Session 実行時の通常 prompt 合成
- hidden な自動更新

### `skills/character-definition-update/SKILL.md`
character 保存時に character directory へ同期する固定 workflow の正本。

責務:
- `character.md` 更新の手順
- `character-notes.md` へ逃がす情報の判断
- 外部調査の許可範囲と source 優先順位
- 更新後の自己チェック

非責務:
- provider 固有の instruction
- 一覧表示用 metadata

## Source Of Truth
- Character catalog の source of truth は file system 上の `meta.json + character.md + character.png`。
- current 実装では `character-notes.md` を補助ファイルとして加える。
- Character Update Workspace では同じ character directory を workspace として再利用する。
- provider 向け instruction file と update skill は create / update の保存時に同期しておき、workspace 起動時はそのまま使う。
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
8. Character Update Workspace 用の instruction file 生成
9. Character Update Workspace 用 skill file の生成

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

### Character Update Session
- Character Editor から provider を選んで起動する
- `workspacePath` は character directory をそのまま使う
- 表示面は専用 window ではなく `Session Window` の `character-update` variant とする
- 右ペインでは `LatestCommand / MemoryExtract` を表示する
- file system 直接操作はしない

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
  notesMarkdown: string;
  updatedAt: string;
};
```

## Save Rules
- 新規作成時は `<character-id>/` を作成する。
- `character-id` は name から slug 化して作る。
- 同名衝突時は suffix を付与して回避する。
- 保存は `meta.json` と本文ファイルを同一操作として扱う。
- `character.md` が未作成かつ入力が空の場合は、最小テンプレートを seed する。
- `character-notes.md` が未作成かつ入力が空の場合は、notes テンプレートを seed する。
- `character.png` 未設定時は placeholder ではなく空ファイルを作らず、icon なしとして扱う。
- 画像が指定された場合は source path から character directory 配下へコピーし、Renderer には保存後の絶対パスを返す。

## Delete Rules
- 削除は character directory 単位で行う。
- Home からは直接削除せず、Character Editor からのみ実行する。
- character を解決できない session は新規 turn を続行しない。
- ただし session 自体は削除せず、過去ログ / audit / diff を読むための `browse-only` / `view-only` 相当状態を許容する。
- 同名 character の再作成時でも、`name` fallback で別 character へ自動再接続させない。

## Current Implementation と future 方針

- session 側に character snapshot が残るため、一覧表示は継続できる場合がある。
- `characterId` を正本とし、未解決時は `閲覧のみ可能 / 実行不可` として扱う。
- `name` だけを使った再接続は行わない。
- Home / Session では「過去の session 記録を読む導線」と「今後の実行可否」を分けて表現する。

## Migration Policy
- Electron 実行時は file-based storage を正本にする。
- character root が空でも、そのまま empty state を表示して新規作成を促す。

## Current / Target Boundary

### Current

- `meta.json`
- `character.md`
- `character-notes.md`
- `character.png`
- `AGENTS.md`
- `copilot-instructions.md`
- `skills/character-definition-update/SKILL.md`

### Target

- Character Update Workspace で `character-notes.md` も前提にした更新運用
- `character-notes.md` のテンプレートや revision 補助をどこまで UI に持たせるかの判断

## Open Questions
- import/export をどの形式で扱うか
- Session が character snapshot をどこまで保持するか
