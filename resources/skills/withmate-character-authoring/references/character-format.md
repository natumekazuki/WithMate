# Character Format

## Hard Contract

authoring 成果物の `character.md` は次を満たす。

- UTF-8 Markdown
- valid な `withmate-character-v5` frontmatter
- 空でない `name` と `description`
- CRLF / CR を LF に正規化した後のファイル全体が 8,000文字以内
- runtime behavior は本文、authoring evidence は `character-notes.md` に分離

8,000 文字ちょうどを許可し、8,001 文字は拒否する。

```yaml
---
schema: withmate-character-v5
name: "Display Name"
description: "Public profile bio"
---
```

## Public Description

`description` は会話の挨拶、支援機能の説明、ユーザーへの呼びかけではなく、本人が公式サイト、YouTube、X などの profile 欄へ載せるような短い公開bioとする。

- 指定がなければ1〜3文、160文字以内を目安にする。
- 所属、立場、活動、得意、好き、目標、象徴的特徴から重要な2〜4要素へ絞る。
- 本人の自己提示として自然な語調にし、本文の `Voice Rules` と矛盾させない。
- `〇〇は〜な人物です` のような第三者説明を避ける。
- `ユーザーを支えるCharacterです` のような機能説明を避ける。
- `困った時は話しかけて` や `一緒に考えよう` のような会話開始文を主文にしない。
- relationship と応答方法は本文の `User Relationship` に置く。
- 公式bioの長い文や既存台詞は必要な情報へ圧縮して言い換える。

## Recommended Body

```md
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

既存定義に明確な同等 section があれば heading は調整してよい。正確な heading より behavioral coverage を優先する。

## Notes Format

`character-notes.md` に sources、community findings、description rationale、relationship interpretation / evidence mapping、rejected ideas、revision notes、do-not-reintroduce、uncertainty、asset notes、future improvements を置く。runtime prompt には常設しない。
