# Character Definition Format

- 作成日: 2026-03-29
- 更新日: 2026-08-01
- 対象: `character.md` と `character-notes.md`

## Goal

`character.md` をユーザー向け response behavior の runtime 正本とし、調査、解釈、改稿履歴を `character-notes.md` へ分離する。

保存場所と metadata は `docs/design/character-storage.md`、prompt への投影は `docs/design/prompt-composition.md`、authoring flow は `docs/design/character-authoring-growth.md` を参照する。8,000 文字制約と authoring 境界の判断理由は `docs/adr/010-character-authoring-project-contract.md` に置く。

## Responsibility Split

### `character.md`

- person-first の実行可能な response definition
- ユーザーとの距離、反応、話し方、温度
- 状況別の振る舞いと短い例
- prompt composition の主要入力

次は含めない。

- 長い作品紹介、調査ログ、出典一覧
- authoring workflow、WithMate 実装、provider instruction
- rights、uncertainty、採用しなかった解釈、改稿ログ

### `character-notes.md`

- source と community finding
- public description と relationship の解釈根拠
- uncertainty、rights、rejected ideas
- revision notes、do-not-reintroduce、future improvements

runtime prompt の常設入力にはしない。

## Executable Format Contract

`character.md` は次を満たす。

- UTF-8 Markdown
- YAML frontmatter に `schema: withmate-character-v5` と空でない `name` を持つ
- frontmatter 後の本文が空でない
- null byte を含まない
- CRLF と CR を LF に正規化した後の Unicode code point 数が 8,000 以下
- 本文中の相対 path 参照が絶対 path、backslash、`..` traversal、null byte を含まない

frontmatter parser は `key: value` の flat scalar subset だけを扱う。nested object、array、multiline scalar は扱わない。legacy file との互換のため `description` 欠損は空文字として読むが、新規作成と authoring では public profile bio を明示する。

`character-notes.md` は optional とする。存在する場合は null byte を含まず、UTF-8 byte size が 256 KiB 以下であることだけを hard contract とする。authoring で必要になった時は固定 Skill の template から作成する。

実装の正本は `src/character/character-definition.ts`、境界検証は `scripts/tests/character-definition-format.test.ts` と `scripts/tests/character-storage.test.ts` を参照する。

## Recommended Runtime Shape

```md
---
schema: withmate-character-v5
name: "Display Name"
description: "Public profile bio"
---

# Character Definition

## Experience Goal
## Core Presence
## User Relationship
## Default Response Style
## Work / Response Separation
## Natural Reactions
## Situation Styles
## Voice Rules
## Emotional Texture
## Signature Phrases
## Character Priority
## Minimal Reliability
## Examples
```

section 名は既存定義に明確な同等 section があれば変更してよい。重要なのは次の behavioral coverage である。

- Character 性は自然言語の wording、相槌、励まし、ツッコミ、距離感、温度へ反映する。
- file operation、検索、diff、test/build、repository instruction、未確認事実は通常の coding agent として正確に扱う。
- relationship は初期距離と、作業、調査、失敗、成功、疲労、冗談、意見不一致への具体的な反応を持つ。
- 恋愛、独占、依存は明示された根拠なしに一般的な親しさへ混ぜない。

`description` は public profile bio として作る。authoring target は通常 1〜3 文、160 文字以下だが、storage hard validation にはしない。

## Update Policy

- 既存 file は差分更新を優先する。
- `character.md` に長い evidence や rights notes を置かない。
- managed icon は storage metadata の責務とし、本文へ asset section を要求しない。
- direct file edit で hard contract を外れた定義は runtime snapshot に投影しない。
