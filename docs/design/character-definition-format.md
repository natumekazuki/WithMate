# Character Definition Format

- 作成日: 2026-03-29
- 更新日: 2026-09-04
- 対象: `character.md` と `character-notes.md`

## Goal

`character.md` をユーザー向け response behavior の runtime 正本とし、調査、解釈、改稿履歴を `character-notes.md` へ分離する。

保存場所と metadata は `docs/design/character-storage.md`、prompt への投影は `docs/design/prompt-composition.md`、authoring flow は `docs/design/character-authoring-growth.md` を参照する。8,000 文字制約と launch 境界の判断理由は `docs/adr/010-character-authoring-project-contract.md`、Kernel 品質契約は `docs/adr/011-character-authoring-kernel.md` に置く。

## Responsibility Split

### `character.md`

- person-first の実行可能な response definition
- Character 固有の注意、評価、対人目的、感情、判断
- ユーザーとの距離、話し方、状態による変調
- prompt composition の主要入力

次は含めない。

- 長い作品紹介、調査ログ、出典一覧
- authoring workflow、WithMate 実装、provider instruction
- rights、uncertainty、採用しなかった解釈、改稿ログ

### `character-notes.md`

- source と community finding
- public description と relationship の解釈根拠
- observation、Character Kernel の導出、voice evidence
- uncertainty、rights、rejected ideas、revision guardrail
- revision notes、validation result、future improvements

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

## Recommended Character Kernel

新規作成と full authoring では、Character らしさを次の三層で設計する。

```text
Characterらしさ
= 選択の核
× 言語アイデンティティ
× 状態変調
```

```md
---
schema: withmate-character-v5
name: "Display Name"
description: "Public profile bio"
---

# Character Kernel

## Identity Core
## Attention and Appraisal
## Social Intent / User Relationship
## Emotional Dynamics and Core Tensions
## Thinking and Action Style
## Voice Rules
### Identity Invariants
### Distributional Tendencies
### Triggered Markers
## State Modulation
## Character Priority
## Minimal Reliability
```

section 名は意味を保つ範囲で変更できる。Character Kernel は authoring 品質の推奨契約であり、parser の hard contract ではない。旧 section 構成や既存 `Examples` を含む Character も引き続き読み込める。targeted update では、既存構造だけを理由に全面 rewrite しない。

full authoring では次の behavioral coverage を満たす。

- Identity Core は、設定の羅列ではなく、自分をどう位置づけて会話でどの役割を取るかを示す。
- Attention and Appraisal は、何へ最初に気づき、どう意味づけ、価値が競合した時に何を優先するかを示す。
- Social Intent / User Relationship は、ユーザーを何者として扱い、相手へ何を起こそうとするかを示す。
- Emotional Dynamics and Core Tensions は、感情の立ち上がり、表出、収まり方と、通常傾向が反転する条件・上位原理を示す。
- Thinking and Action Style は、不確実さ、失敗、判断、説明へ向き合う Character 固有の順序を示す。
- Voice Rules は一人称、ユーザー基本呼称、敬語、構文、語彙、表記を identity invariant、分布傾向、triggered marker に分ける。一人称と基本呼称には正確な表記、使用場面、省略方針、頻度、状態による語気調整を持たせる。
- State Modulation は、真剣、高揚、照れ、苛立ち、疲労、長い説明、意見不一致などで、注意、social intent、感情強度、文量、敬語、呼称、marker 頻度がどう変わるかを示す。
- Character Priority は制約時に残す特徴の順序、Minimal Reliability は実行・確認状態、会話内記憶、必要な注意の境界を示す。
- file operation、検索、diff、test/build、repository instruction、未確認事実は通常の coding agent として正確に扱う。
- 恋愛、独占、依存は明示された根拠なしに一般的な親しさへ混ぜない。
- 完成返答の `Examples` や場面別台詞集へ依存せず、一つの規則を複数の未知場面へ一般化する。

`description` は public profile bio として作る。authoring target は通常 1〜3 文、160 文字以下だが、storage hard validation にはしない。

## Authoring Notes

full authoring では `character-notes.md` に次を記録する。

- 公式・一次情報と community source の coverage と役割分担
- 状況、最初の着眼点、評価、対人行為、感情推移、言語特徴の observation
- Character Kernel と Voice Rules の導出根拠
- runtime への採用、保留、不採用と uncertainty
- 既存 identity を守る revision guardrail
- Name-swap、Phrase-suppression、Voice-restoration、Unseen-scenario、Paraphrase diversity、Marker-overuse、Core-tension、Long-form retention、relationship smoke test の結果

## Update Policy

- 既存 file は差分更新を優先する。
- `character.md` に長い evidence や rights notes を置かない。
- 既存 Character を自動 migration または一括 rewrite しない。
- managed icon は storage metadata の責務とし、本文へ asset section を要求しない。
- direct file edit で hard contract を外れた定義は runtime snapshot に投影しない。
