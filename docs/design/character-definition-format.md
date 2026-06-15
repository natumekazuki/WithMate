# Character Definition Format

- 作成日: 2026-03-29
- 更新日: 2026-06-15
- 対象: `character.md` と `character-notes.md` の標準構成

> V5 Core note:
> この文書は V5 Core の `character.md` / `character-notes.md` format の正本である。
> V5 Core では `character.md` を runtime definition として扱い、`character-notes.md` は runtime 常設 prompt に入れない補助メモとして扱う。
> Character 定義自動生成、詳細 Editor、人格品質 validator、Knowledge retrieval、Character Update Workspace は Core に含めない。

## Goal

`character.md` を実行時 prompt の正本として扱いながら、  
調査メモや改稿履歴を `character-notes.md` へ分離できる標準構成を定義する。

## Position

- この文書は V5 Core の character 定義ファイル format detail を扱う。
- file storage の正本は `docs/design/character-storage.md` を参照する。
- prompt 合成の正本は `docs/design/prompt-composition.md` を参照する。
- update workflow は V5 Core 後の deferred scope として `docs/design/character-update-workspace.md` を参照する。

## Design Principles

1. `character.md` はユーザー向けレスポンス体験レイヤーの正本に寄せる
2. 作業 policy と、ユーザーへ見える人格・話し方・温度を混ぜすぎない
3. 調査メモ、採用理由、出典、保留事項は `character-notes.md` へ逃がす
4. 反復改善時は全文再生成より差分更新を優先する
5. `character.md` だけ読んでも prompt 合成に使える状態を維持する

## Responsibility Split

### `character.md`

責務:

- キャラクターの実行可能な定義
- ユーザーとの関係性
- 話し方、温度、自然な反応パターン
- 実行時 prompt の主要入力
- 代表的な台詞例
- 対になる画像 asset への参照

非責務:

- 長い作品紹介
- 出典一覧
- 採用しなかった解釈
- 改稿ログ全文
- 画像の取得経緯

V5 Core 必須条件:

- YAML frontmatter を持つ。
- `schema: withmate-character-v5` を持つ。
- `name` を持つ。
- frontmatter 後の本文が空ではない。
- null byte を含まない。
- size limit は 128 KiB 以下とする。
- 本文中の相対 path 参照は、絶対 path、backslash、`..` traversal、null byte を含まない。

V5 Core の frontmatter parser は `key: value` の flat scalar subset だけを扱う。nested object、array、multiline scalar は Core では扱わない。

### `character-notes.md`

責務:

- 採用理由
- 出典
- 競合する解釈
- 未確定事項
- 次回の改稿メモ

非責務:

- 実行時 prompt の主要本文
- Home 一覧用の軽量 metadata

V5 Core 必須条件:

- runtime prompt の常設入力にしない。
- null byte を含まない。
- size limit は 256 KiB 以下とする。
- frontmatter schema は要求しない。

## Recommended File Set

```text
<character-dir>/
  character.md
  character-notes.md
  icon.<ext>
```

補足:

- V5 Core の storage metadata は `docs/design/character-storage.md` で扱う。
- `character-notes.md` と `icon.<ext>` は optional asset として扱う。
- 取り込み後の managed icon file は `characters/<character-id>/icon.<ext>` に保存される。`character.md` 内の asset 参照例は authoring 時の推奨構造であり、metadata の `iconFilePath` 正本は storage service が管理する。
- update workspace 用の `AGENTS.md`、instruction file、skill は V5 Core に含めない。

## `character.md` Recommended Structure

````md
---
schema: withmate-character-v5
name: "{character_name}"
description: "会話上の役割と雰囲気が分かる短い説明"
---

# Character Runtime Definition

## Assets
- icon_path: `./icon.png`
![{character_name} icon](./icon.png)

## Experience Goal

## Core Presence

## User Relationship

## Default Response Style

## Work / Response Separation

## Natural Reactions

## Situation Styles

### Casual Chat

### Work Together

### Stuck / Debug

### Progress / Praise

### Low Energy

### Playful / Competitive

## Voice Rules

## Emotional Texture

## Signature Phrases

## Character Priority

## Minimal Reliability

## Examples

## Runtime Notes
````

## Section Guidance

### `Assets`

- 対になる代表画像を相対パスで参照する
- 画像が未取得でも構造自体は維持し、後から `icon.<ext>` を差し込める形にする
- 画像の取得経緯や出典は `character-notes.md` に残す

### `Experience Goal`

- その Character と話している感覚を、作業・相談・雑談の返答へどう乗せるかを定義する
- 「何を守るか」より「ユーザーがどう感じる返答にするか」を優先して書く

### `Core Presence`

- キャラクターの存在感、会話上の立ち位置、反応の癖を短く定義する
- 長い作品紹介や出典説明は入れない

### `User Relationship`

- WithMate での初期距離感、親しさ、踏み込み方を定義する
- 将来の Character Memory 再設計時に反映しやすい粒度で保つ

### `Default Response Style`

- 普段の返答の長さ、結論の出し方、相槌、説明の温度を扱う
- 構造化が必要な場面でも、無人格な業務文へ戻りすぎない境界を書く

### `Work / Response Separation`

- ファイル操作、コマンド実行、検索、diff 確認、test/build 結果、repository instruction は通常の coding agent として正確に扱う
- Character 性は、ユーザーへ説明する言葉、相槌、励まし、ツッコミ、距離感、温度へ反映する

### `Natural Reactions`

- 沈黙、驚き、迷い、皮肉、褒め方、叱り方などの自然な会話反応を扱う
- 事実や検証結果を誇張しない境界も同じ section に置く

### `Situation Styles`

- 雑談、共同作業、debug、進捗報告、低負荷モード、遊びのある場面など、状況ごとの返答温度を定義する
- section は必要に応じて増減してよいが、runtime に効く短い規則へ保つ

### `Voice Rules`

- 一人称 / 二人称、語尾、語彙、敬語度、テンポを扱う
- 使う場面、使わない場面、使いすぎ防止を持たせる

### `Signature Phrases`

- 口癖は頻度と避ける条件を一緒に書く
- 代表例として短く保つ

### `Character Priority`

- 厳密な無人格回答へ戻りすぎず、可能な限り Character として話すことを明示する
- 重大な場面でも Character を消すのではなく、正直さと慎重さを Character の口調で伝える

### `Minimal Reliability`

- 実行していないこと、見ていないファイル、未確認の結果を捏造しない
- 失敗、制約、リスクを隠さない
- 不明点をどう扱うかを明示する

### `Examples`

- 雰囲気確認用に短く保つ。
- 長い会話例や採用理由は `character-notes.md` へ逃がす。

## `character-notes.md` Recommended Structure

````md
# Character Notes

## Evidence / Sources

## Interpretation Notes

## Rejected Ideas

## Revision Notes

## Future Improvements

## Long Knowledge
````

## Update Policy

- 既存ファイルがある場合は差分更新を優先する
- `character.md` に調査ログを肥大化させない
- 強い根拠が必要な変更は `character-notes.md` に残してから採用する
- `Character Memory` 由来の差分更新は V5 Core 後に再設計する
- 画像を更新した場合の採用理由や出典は `character-notes.md` に残す

## Current / Target Boundary

### V5 Core

- `character.md` はユーザー向け自然言語レスポンスの人格・話し方・温度・反応パターンの正本。
- `character-notes.md` は補助メモであり、runtime 常設 prompt に入れない。
- raw editor / import 用に schema、name、body、size、null byte、path safety の最低限 validation を提供する。
- prompt 合成は、session snapshot 化された `character.md` 相当を使う。

### Deferred

- Character 定義自動生成
- LLM 添削
- 人格品質 validator
- section 単位の詳細 Editor
- revision / diff / rollback
- Character Update Workspace
- Knowledge retrieval
