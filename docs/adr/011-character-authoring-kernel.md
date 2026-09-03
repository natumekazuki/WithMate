# ADR 011: Character authoring の Kernel 品質契約

- Status: Accepted
- Date: 2026-09-04
- Supersedes: ADR 010 の fixed Skill quality model

## Context

ADR 010 は、WithMate がapp管理の固定Skillをprovider固有rootへ配布し、targeted updateとfull authoringを分ける境界を定めた。従来のSkillは、`Natural Reactions`、`Situation Styles`、完成返答の`Examples`を推奨していた。この構成は既知場面の再現には使えるが、未知場面への一般化、markerを抑えた時のCharacter性、長文中のvoice維持を直接設計しにくい。

ChatGPT Pro向けCharacter Authoring Projectでは、Characterらしさを選択の核、言語アイデンティティ、状態変調の組み合わせとして導出し、observationとruntime規則を分離する設計へ更新された。WithMateへ取り込む際は、Character storage、Session、provider、snapshotの既存境界を維持する必要がある。

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

Voice RulesはIdentity Invariants、Distributional Tendencies、Triggered Markersに分ける。一人称と任意の一人へ使えるユーザー基本呼称には、正確な表記、使用場面、省略方針、頻度、必要な語気調整を持たせる。口癖や反応語にはtrigger、function、intensity、placement、frequency、variationを持たせる。

完成返答の`Examples`や場面別台詞集を新しいruntime定義へ置かない。既存例から必要なsignalを取り出す場合は、注意、評価、social intent、state modulation、voiceの生成規則へ変換する。

### Targeted updateと後方互換

targeted updateは依頼箇所を所有する最小sectionだけを変更し、既存の有用なidentityを保持する。旧section構成や既存`Examples`があることだけではfull authoringへ広げず、全面rewriteしない。

Character Kernelのsection構成はauthoring品質の推奨契約とし、`character.md` parserのhard contractにはしない。`schema: withmate-character-v5`、空でない`name`、空でない本文、LF正規化後8,000 Unicode code point以下という既存contractを維持し、旧Characterへ自動migrationまたは一括rewriteを要求しない。

### Evidenceと検証

full authoringでは、公式・一次情報を事実確認と強い定義の根拠に使い、community sourceを口癖、反応、時期差、代表場面の手掛かりに使う。状況、最初の着眼点、評価、対人行為、感情推移、言語特徴をobservationとして分解し、採否、uncertainty、revision guardrail、validation結果とともに`character-notes.md`へ記録する。

Name-swap、Phrase-suppression、Voice-restoration、Unseen-scenario、Paraphrase diversity、Marker-overuse、Core-tension、Long-form retention、7ケースのrelationship smoke testをfull authoringの検証に使う。

### WithMate境界

ADR 010のstorage、launch、provider、snapshot判断を維持する。Notion同期、CharacterPack Zip、asset生成・配布、catalog metadataの色更新、`config.toml`、Memory、unrelated Session historyからのhidden inputは固定Skillの必須処理へ含めない。

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
