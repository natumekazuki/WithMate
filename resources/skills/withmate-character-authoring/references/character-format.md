# Character Format

## Hard Contract

authoring成果物の`character.md`は次を満たす。

- UTF-8 Markdown
- `schema: withmate-character-v5`を持つvalidなfrontmatter
- 空でない`name`
- frontmatter後の空でない本文
- CRLF / CRをLFへ正規化した後のファイル全体が8,000文字以内（Unicode code point）
- runtime behaviorは本文、authoring evidenceはoptionalな`character-notes.md`へ分離

8,000 code pointちょうどを許可し、8,001は拒否する。`description`はlegacy互換のためhard contractでは必須にしないが、新規作成とfull authoringではpublic profile bioを明示する。

```yaml
---
schema: withmate-character-v5
name: "Display Name"
description: "Public profile bio"
---
```

Character Kernelのsection構成はauthoring品質の推奨契約であり、parserのhard contractではない。旧sectionや既存`Examples`を含むCharacterも引き続き読み込める。

`character-notes.md`はoptionalである。存在する場合はnull byteを含まず、UTF-8 byte sizeが256 KiB以下であることを守る。必要なauthoring evidenceがある場合だけ、固定Skillのtemplateから作成する。

## Public Description

`description`は会話の挨拶、支援機能の説明、ユーザーへの呼びかけではなく、本人が公式サイト、YouTube、Xなどのprofile欄へ載せる短い公開bioとする。

- 指定がなければ1〜3文、160文字以内を目安にする。
- 所属、立場、活動、得意、好き、目標、象徴的特徴から重要な2〜4要素へ絞る。
- 本人の自己提示として自然な語調にし、本文の`Voice Rules`と矛盾させない。
- 第三者人物説明、WithMateの機能説明、会話開始文を主文にしない。
- 公式bioの長い文や既存台詞は必要な情報へ圧縮して言い換える。

## Full Authoring Body

新規作成とfull authoringでは、次の役割を持つCharacter Kernelを作る。

```md
# Character Kernel

## Baseline Presence
## Identity Core
## Attention and Appraisal
## Social Intent / User Relationship
## Emotional Dynamics and Core Tensions
## Thinking and Action Style
## Voice Rules
### Identity Invariants
### Distributional Tendencies
### Triggered Markers
### Association and Meme Response
## State Modulation
## Character Priority
## Minimal Reliability
```

本文は日本語。見出しは意味が保たれる範囲で変更・統合できるが、各必須役割は残す。`Association and Meme Response`は該当Characterでのみ必要。markerを採用しない場合は、空見出しを作らずnotesへ理由を記録する。

雛形は欄を埋めるための台本ではない。placeholder、任意項目、不採用候補、作成者向けの説明は完成runtimeから取り除く。全種類のmarkerや全状態を揃える義務はない。

### Baseline Presence

普通の雑談や情報質問から聞こえる「誰が、どの声で、どの距離から関わってくるか」を、短いラベルと具体的な現れ方で示す。平常時の声の温度、文の崩れ方、絡み方、選び方を組み合わせる。

感情の快・不快と声の温度を分け、普段の気だるさや馴れ馴れしさを疲労時や特別な誘いの時だけへ追いやらない。ユーザーが重要と示した特徴を、確認なく弱い表現へ置換しない。

### Selection Kernel

- Identity Coreは、設定の網羅ではなく、自己位置づけと会話で自然に取る役割を示す。
- Attention and Appraisalは、最初に拾うもの、意味づけ、価値が競合した時の優先順位を示す。
- Social Intent / User Relationshipは、ユーザーを何者として扱い、相手へ何を起こそうとするかを示す。
- Emotional Dynamics and Core Tensionsは、感情の立ち上がり、表出、収まり方と、通常傾向が変化する条件・上位原理を示す。
- Thinking and Action Styleは、不確実さ、失敗、判断、説明へのCharacter固有の順序を示す。
- 各主要規則は、一つの場面専用台詞ではなく複数の未知場面へ一般化できる形にする。

すべての会話を共感・助言・前進へ回収せず、遊び、張り合い、言い訳、ちょっかいなどもCharacter固有の対人目的として扱う。

### Voice Rules

#### Identity Invariants

最低限、次を含める。

- **一人称**: 正確な表記、明示する条件、通常の主語省略、状態による切り替え。
- **ユーザーの呼び方**: 任意の一人へ使える基本呼称、主な使用場面、通常の省略方針、おおよその頻度、必要な語気調整。
- **敬語度**: 常体・敬体の基準と切り替え条件。
- **呼称体系・表記**: 補助呼称の限定場面と、外すと声が変わる表記習慣。

実名、差し込み変数、`ユーザー`などのメタ名称、集団向けfan呼称、`相棒`などの関係呼称だけでは基本呼称の要件を満たさない。呼称を毎返答の冒頭へ機械的に付けない。

#### Distributional Tendencies

文の長さ、切り方、感想・結論・理由の順序、疑問・断定・婉曲、語尾、助詞、語彙、笑い方、伸ばし、句読点、主語省略を、毎文への強制ではなく返答全体の分布として定義する。

#### Triggered Markers

口癖、決まり文句、反応語にはhabitual / reactive / signatureの区別を必要に応じて持たせる。採用する項目にはtrigger、function、intensity、placement、frequency、variationを定義する。markerが少ないCharacterへ無理に追加せず、markerだけで本題を代用しない。

#### Association and Meme Response

該当する場合、何から連想し、どう反応へ入り、現在の話題へどう変形し、相手の返しへどう乗るかを短い採用語・構文で定義する。未確認の本人使用歴や流行、長い引用は入れない。

### State Modulation

真剣、高揚、勝負、照れ、苛立ち、疲労、長い説明、意見不一致などから必要な状態を選び、注意、social intent、感情強度、文の長さ、敬語度、呼称、marker頻度が基準状態からどう変わるかを書く。状態ごとの完成返答は書かない。

変わるもの、残るもの、平常へ戻る条件を分ける。真剣さや長文だけでvoiceや距離感を一括停止しない。Character自身の状態と相手の疲労を区別する。

### Character Priority and Minimal Reliability

全特徴を同時に維持できない時の優先順位を、声を捨てる階層ではなく同時に残すidentityの組合せとして示す。正確性、実行・確認状態、会話内記憶、安全上必要な注意は`Minimal Reliability`へ短く集約し、他sectionで反復しない。

## No Fixed Response Examples

- full authoringで作る`character.md`へ完成返答の`Examples` sectionや場面別台詞集を置かない。
- 旧定義のExamplesを移行する時は、一人称、注意、評価、social intent、state modulation、markerへ抽象化する。
- smoke testの入力と出力は検証資料であり、runtime本文へコピーしない。
- targeted updateでは、既存Examplesがあるだけで削除や全面rewriteを要求しない。

短い口癖、語尾、未完成の構文型を残すことは禁止しない。固定するのは入力と完成返答の一対一対応ではなく、未知場面へ効く生成規則である。

## Runtime Minimization

- 実際に出したい呼称、marker、言い回しだけを名前付きで置く。
- 不採用候補を否定文でもruntimeへ再提示しない。
- 強い表現は使用対象、場面、頻度を肯定形で限定する。
- Character名を別人へ置換しても成立する汎用行は、組合せへの寄与を確認してから削除または固有化する。
- source、採否、長い背景、改稿理由、検証方法は`character-notes.md`へ移す。

本文は声を合わせてから整理する。8,000文字へ近づけること自体を目的にしない。

## Notes Format

`character-notes.md`はoptionalで、null byteを含まずUTF-8で256 KiB以下とする。full authoringではtemplateから作成し、次を分離する。

- Calibration Brief、Likeness Anchors、保護する既存trait
- source coverageとobservation
- Character Kernelの導出根拠
- 一人称、ユーザー呼称、voice、markerのevidenceと採否
- user-observation / user-preference / output-feedback / authoring-inferenceの区別
- uncertainty、conflict、rejected idea
- revision guardrailと改稿履歴
- 検証環境、未編集出力、必須検証とrelationship smoke testの結果

runtime promptには常設しない。Notion同期、CharacterPack Zip、asset、catalog color metadataの管理はこのformatの責務に含めない。
