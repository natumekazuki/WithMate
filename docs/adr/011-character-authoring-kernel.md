# ADR 011: Character authoring の Kernel 品質契約

- Status: Accepted
- Date: 2026-09-04
- Updated: 2026-09-12
- Supersedes: ADR 010 の fixed Skill quality model

## Context

ADR 010 は、WithMate がapp管理の固定Skillをprovider固有rootへ配布し、targeted updateとfull authoringを分ける境界を定めた。従来のSkillは、`Natural Reactions`、`Situation Styles`、完成返答の`Examples`を推奨していた。この構成は既知場面の再現には使えるが、未知場面への一般化、markerを抑えた時のCharacter性、長文中のvoice維持を直接設計しにくい。

ChatGPT Pro向けCharacter Authoring Projectでは、Characterらしさを選択の核、言語アイデンティティ、状態変調の組み合わせとして導出し、observationとruntime規則を分離する設計へ更新された。2026-09-11のdialogue-calibrated-v1では、Baseline Presence、Likeness Anchor、marker不足、複数ターン継続、regression、検証provenanceを追加して、質問票中心のauthoringから出力校正中心へ品質モデルを広げた。2026-09-12のdialogue-calibrated-v2では、会話と実作業の併用を標準用途とし、作業中のCharacter Presence、時間順のTask-execution / Conversation-work Continuity、Work Likeness / Task Integrity / Collaboration Comfort、作業eventのprovenance、成果物との声の分離を追加した。WithMateへ取り込む際は、Character storage、Session、provider、snapshotの既存境界を維持する必要がある。

## Decision

### Full authoringのKernel

新規作成とfull authoringでは、Characterらしさを次の三層で構成する。

```text
Characterらしさ
= 選択の核
× 言語アイデンティティ
× 状態変調
```

`character.md`は、Identity Core、Attention and Appraisal、Social Intent / User Relationship、Emotional Dynamics and Core Tensions、Thinking and Action Style、Voice Rules、State Modulation、Character Priority、Minimal Reliabilityの役割を持つ。

平常時のBaseline Presenceと保護するLikeness Anchorを先に定める。Voice Rulesのmarkerはhabitual / reactive / signatureに分け、出現機会の不足と過剰を別に検証する。ネット反応がCharacterのidentityに関係する場合は、Association and Meme Responseを任意sectionとして使う。

Voice RulesはIdentity Invariants、Distributional Tendencies、Triggered Markersに分ける。一人称と任意の一人へ使えるユーザー基本呼称には、正確な表記、使用場面、省略方針、頻度、必要な語気調整を持たせる。口癖や反応語にはtrigger、function、intensity、placement、frequency、variationを持たせる。

WithMateの標準用途はconversation-and-workとし、コード・資料・tool結果への着眼、見立ての修正、部分成功、途中の質問・変更・中止、作業から会話への復帰にも既存の声と距離を残す。会話専用の明示指定は作業testの非該当として理由を記録する。仕事用の別人格、毎toolの実況、固定台詞は追加しない。

完成返答の`Examples`や場面別台詞集を新しいruntime定義へ置かない。既存例から必要なsignalを取り出す場合は、注意、評価、social intent、state modulation、voiceの生成規則へ変換する。

### Targeted updateと後方互換

targeted updateは依頼箇所を所有する最小sectionだけを変更し、既存の有用なidentityを保持する。旧section構成や既存`Examples`があることだけではfull authoringへ広げず、全面rewriteしない。

Character Kernelのsection構成はauthoring品質の推奨契約とし、`character.md` parserのhard contractにはしない。`schema: withmate-character-v5`、空でない`name`、空でない本文、LF正規化後8,000 Unicode code point以下という既存contractを維持し、旧Characterへ自動migrationまたは一括rewriteを要求しない。

### Evidenceと検証

full authoringでは、公式・一次情報を事実確認と強い定義の根拠に使い、community sourceを口癖、反応、時期差、代表場面の手掛かりに使う。状況、最初の着眼点、評価、対人行為、感情推移、言語特徴をobservationとして分解し、採否、uncertainty、revision guardrail、validation結果とともに`character-notes.md`へ記録する。

Baseline / Anchor-presence、Name-swap / Combination、Phrase-suppression、Voice-restoration、Marker-underuse / Marker-overuse、Unseen-scenario、Paraphrase diversity、Core-tension、Long-form retention、Multi-turn continuity / Return-to-baseline、Regression / Protected-trait、7ケースのrelationship smoke testをfull authoringの検証に使う。作業用途ではTask-execution / Conversation-work Continuityを追加し、Work Likeness / Task Integrity / Collaboration ComfortとFunctional verificationを別評価する。synthetic-event、recorded-tool-replay、live-tool-executionはauthoring環境とは独立に記録し、各結果はprovenanceとともにpass、fail、inconclusive、not-run、not-applicableを区別する。Phrase-suppressionは診断であり、markerを消すことを品質目標にしない。

改善指示は通常Sessionのメッセージから受け取り、既存定義、notes、フィードバックを読んでPreserve / Revise / Investigateへ分類する。出力上の現象、原因仮説、規則変更、別入力での検証を対応付け、未実施やinconclusiveをpassと扱わない。

### WithMate境界

ADR 010のstorage、launch、provider、snapshot判断を維持する。Notion同期、CharacterPack Zip、asset生成・配布、catalog metadataの色更新、`config.toml`、Memory、unrelated Session historyからのhidden inputは固定Skillの必須処理へ含めない。

作業中の発話を検証する場合も、synthetic-eventやrecorded-tool-replayだけで実編集・実行の成功を主張しない。ユーザー向けの作業報告と、納品コード・設定・文書の形式・文体を分け、作業用の別人格や毎toolの実況を導入しない。

## Alternatives

### ChatGPT Projectの全成果物と連携を複製する

Notion、Zip、asset、color metadataはWithMate内authoringとは別ownerであり、Character rootの保存境界を広げるため採用しない。

### Kernel sectionをparserで必須化する

既存Characterを読み込めなくなり、品質推奨とstorage hard contractを混同するため採用しない。

### Targeted updateでも全面変換する

局所修正で有用なidentityとユーザーの意図を失う危険があり、実行コストも目的に比例しないため採用しない。

## Consequences

- 次回開始するAuthor / Improve Sessionには更新済み固定Skillが配布される。
- 新規作成とfull authoringは未知場面への一般化とvoiceの独立性を検証する。
- targeted updateは既存の有用なidentityを保持する。
- 旧Characterは既存hard contractのまま読み込める。
- authoring evidenceとruntime definitionの分離が明確になる。
- 会話と実作業の往復におけるCharacter性を検証でき、未実行の機能検証を成功扱いしない。
