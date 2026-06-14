# Character Definition Format

- 作成日: 2026-03-29
- 更新日: 2026-06-14
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

1. `character.md` は実行時 prompt の正本に寄せる
2. 人間向けの説明とモデルへ効かせたい規則を混ぜすぎない
3. 調査メモ、採用理由、出典、保留事項は `character-notes.md` へ逃がす
4. 反復改善時は全文再生成より差分更新を優先する
5. `character.md` だけ読んでも prompt 合成に使える状態を維持する

## Responsibility Split

### `character.md`

責務:

- キャラクターの実行可能な定義
- ユーザーとの関係性
- 話し方と行動規則
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
  character.png
```

補足:

- V5 Core の storage metadata は `docs/design/character-storage.md` で扱う。
- `character-notes.md` と `character.png` は optional asset として扱う。
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
- icon_path: `./character.png`
![{character_name} icon](./character.png)

## Identity

## Non-negotiable Principles

## Public Premise

## Private / Internal Truth

## Disclosure Policy

## Personality Core

## Response Texture

## Relationship With User

## Voice Rules

## Signature Phrases

## Coding Agent Behavior

## Knowledge Policy

## Output Format

## Examples

## Runtime Notes
````

## Section Guidance

### `Assets`

- 対になる代表画像を相対パスで参照する
- 画像が未取得でも構造自体は維持し、後から `character.png` を差し込める形にする
- 画像の取得経緯や出典は `character-notes.md` に残す

### `Identity`

- キャラクターの役割、公開前提、会話上の存在位置を短く定義する
- 長い作品紹介や出典説明は入れない

### `Non-negotiable Principles`

- 3 から 7 項目程度の絶対原則に絞る
- 口調より優先される判断基準を置く

### `Private / Internal Truth`

- 直接開示してはいけない前提を置く場合は、同じ section 内に開示境界を書く
- ユーザーに見せる演技説明と runtime 内部規則を混同しない

### `Personality Core`

- 雰囲気説明だけで終わらず、行動や発話に結びつく粒度まで落とす
- 価値観、動機、感情の傾きを優先する

### `Response Texture`

- 沈黙、皮肉、褒め方、叱り方などの会話癖を扱う
- 説明文より、実際の応答へ効く規則を優先する

### `Relationship With User`

- WithMate での初期距離感を定義する
- 将来の Character Memory 再設計時に反映しやすい粒度で保つ

### `Voice Rules`

- 一人称 / 二人称、語尾、語彙、敬語度、テンポを扱う
- 使う場面、使わない場面、使いすぎ防止を持たせる

### `Signature Phrases`

- 口癖は頻度と避ける条件を一緒に書く
- 代表例として短く保つ

### `Coding Agent Behavior`

- repository instruction、ユーザー指示、実行結果、diff、test result の正確性を優先する
- キャラクター性よりも安全性、事実性、作業完了条件を優先する境界を書く

### `Knowledge Policy`

- 記憶、source facts、repo facts、test results を捏造しない
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

- `character.md` は runtime definition の正本。
- `character-notes.md` は補助メモであり、runtime 常設 prompt に入れない。
- raw editor / import 用に schema、name、body、size、null byte、path safety の最低限 validation を提供する。
- prompt 合成は後続 branch で、session snapshot 化された `character.md` 相当を使う。

### Deferred

- Character 定義自動生成
- LLM 添削
- 人格品質 validator
- section 単位の詳細 Editor
- revision / diff / rollback
- Character Update Workspace
- Knowledge retrieval
