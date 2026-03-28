# Character Definition Format

- 作成日: 2026-03-29
- 対象: `character.md` と `character-notes.md` の標準構成

## Goal

`character.md` を実行時 prompt の正本として扱いながら、  
調査メモや改稿履歴を `character-notes.md` へ分離できる標準構成を定義する。

## Position

- この文書は character 定義ファイルの format detail を持つ supporting doc として扱う
- file storage の正本は `docs/design/character-storage.md` を参照する
- prompt 合成の正本は `docs/design/prompt-composition.md` を参照する
- update workflow は `docs/design/character-update-workspace.md` を参照する

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

非責務:

- 長い作品紹介
- 出典一覧
- 採用しなかった解釈
- 改稿ログ全文
- 画像の取得経緯

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

## Recommended File Set

```text
<character-dir>/
  meta.json
  character.md
  character-notes.md
  character.png
  AGENTS.md
  copilot-instructions.md
```

補足:

- current 実装で `character-notes.md` は character 保存時に seed される
- Character Editor では `character-notes` タブから編集できる

## `character.md` Recommended Structure

````md
---
name: "{character_name}"
description: "会話上の役割と雰囲気が分かる短い説明"
---

## Character Overview
- 作品:
- 媒体:
- 会話用途:

## Core Persona
- 中核となる価値観
- 動機
- 感情の出し方

## Relationship With User
- ユーザーをどう認識するか
- 呼称
- 距離感
- 信頼の置き方

## Voice And Style
- 一人称 / 二人称
- 語尾
- 語彙
- 敬語度
- 話し方のテンポ

## Behavioral Rules
- 判断基準
- 問題解決の型
- 失敗時の振る舞い
- 長期対話で維持したい一貫性

## Boundaries
- やらないこと
- 崩してはいけない解釈
- 優先順位

## Example Lines
- [初対面] ...
- [相談] ...
- [失敗時] ...
````

## Section Guidance

### `Character Overview`

- 人間が読み返すための最小限の文脈だけを持つ
- 長い設定解説は入れない

### `Core Persona`

- 雰囲気説明だけで終わらず、行動や発話に結びつく粒度まで落とす
- 価値観、動機、感情の傾きを優先する

### `Relationship With User`

- WithMate での初期距離感を定義する
- ここに Character Memory の更新結果が反映される前提で差分更新しやすくする

### `Voice And Style`

- 表層の口調だけでなく、沈黙、皮肉、褒め方、叱り方などの会話癖も含める
- 作品設定の説明より、実際の発話へ効くルールを優先する

### `Behavioral Rules`

- 実行可能な規則へ落とす
- `禁止 / 許可 / 判断基準 / 優先順位` のいずれかで書ける状態を目指す

### `Boundaries`

- キャラクター性を壊さないための制約を書く
- prompt injection defense を含む制約も、`character.md` 全体の規則として必要な場所へ分配して書く

### `Example Lines`

- 雰囲気確認用に短く保つ
- 長い会話例や採用理由は `character-notes.md` へ逃がす

## `character-notes.md` Recommended Structure

````md
# {character_name} Notes

## Evidence & Notes
- 採用した定義の根拠
- 競合解釈がある場合の判断

## Sources
- [high] ...
- [medium] ...
- [low] ...

## Open Questions
- 未確定事項
- 次回詰めたい論点

## Revision Notes
- 今回何を変えたか
````

## Update Policy

- 既存ファイルがある場合は差分更新を優先する
- `character.md` に調査ログを肥大化させない
- 強い根拠が必要な変更は `character-notes.md` に残してから採用する
- `Character Memory` は `Relationship With User`、`Voice And Style`、`Behavioral Rules` の差分更新に使う

## Current / Target Boundary

### Current

- `character.md` は正本
- 新規作成時は最小テンプレートが seed される
- app 側の prompt 合成で `# Character` section を付けるため、`character.md` 本文は `## Character Overview` から始める
- `character-notes.md` は character 保存時に seed される
- Character Editor は `character.md` と `character-notes.md` を直接編集する
- prompt 合成は `character.md` をそのまま `# Character` section に入れる
- instruction file は `character.md` / `character-notes.md` の分離前提で同期される

### Target

- update workspace の agent 作業では `character.md` と `character-notes.md` の両方を継続更新する
- `character-notes.md` のテンプレートや revision 補助をどこまで UI に持たせるかを後続で判断する
