# Character Authoring And Improvement

- 作成日: 2026-06-16
- 更新日: 2026-09-04
- 対象: 保存済み Character の agent authoring

## Goal

通常 Session の UI と provider adapter を再利用し、保存済み `character.md` と optional な `character-notes.md` を固定 authoring Skill で作成・改善する。

format は `docs/design/character-definition-format.md`、storage / snapshot は `docs/design/character-storage.md`、launch と保存境界は `docs/adr/010-character-authoring-project-contract.md`、Kernel 品質契約は `docs/adr/011-character-authoring-kernel.md` を参照する。

## Product Flow

1. Character Editor で `Improve with Agent` を押す。
2. 未保存変更がある場合は先に保存する。
3. provider を選び `Start` を押す。
4. WithMate は保存済み Character directory を workspace とする `character-authoring` Session を開く。
5. ユーザーは通常の Session composer から自然言語で改善を指示する。
6. agent は固定 Skill を使って canonical `character.md` / `character-notes.md` を直接編集する。
7. Editor は focus 復帰時に files を再読込し、Save で frontmatter の name / description を catalog metadata へ同期する。

新規 draft は `characterId` が確定するまで authoring を開始できない。起動 dialog に改善指示欄、Skill picker、Agent picker、独自 chat layout は追加しない。

## Launch Boundary

起動入力は mode、保存済み `characterId`、provider と通常 Session runtime options に限定する。Editor draft、`character.md` body、notes、theme、起動時 user instruction は送らない。

provider は必須で、空白除去後の catalog ID を完全一致で解決し、同じ値を Skill root と Session 作成に使う。選択 provider が不明または無効な場合は、別 provider へ fallback せず workspace mutation 前に拒否する。provider 確定から workspace 準備、Session 永続化までは Settings / catalog 更新と同じ provider operation coordinator で直列化する。

Session 準備処理は canonical Character files を書き直さない。optional な `character-notes.md` がない場合も起動時には作成せず、Skill が選んだ mode と記録要否に応じて同梱 template から作成する。catalog metadata は Session title、icon、theme の投影にだけ使う。これにより未保存 draft、line ending、末尾改行を起動副作用から分離する。

保存済み `character.md` が 8,000 文字上限などの hard contract を外れて metadata を parse できない場合、Editor は catalog metadata を draft に維持する。parse failure 自体を未保存 metadata 変更とみなさず、Improve から上限内へ修復できる入口を残す。

## Workspace Boundary

```text
characters/<character-id>/
  character.md
  character-notes.md  # optional。authoring 開始時に Skill が必要なら作成
  AGENTS.md
  AUTHORING_PROMPT.md
  input.json
  .agents/skills/withmate-character-authoring/   # Codex
  .github/skills/withmate-character-authoring/  # Copilot
```

WithMate は起動ごとに選択 provider の Skill directory、`AGENTS.md`、`AUTHORING_PROMPT.md`、`input.json` を再生成する。managed authoring files 以外の root artifact は増やさない。

permanent Character outputs は次に限定する。

- `character.md`
- `character-notes.md`
- managed icon
- SQLite metadata

Project 形式の source report、review checklist、manifest、pack directory、Zip は生成しない。対応する内容は固定 Skill または `character-notes.md` に置く。

## Fixed Skill Contract

app 管理 Skill の正本は `resources/skills/withmate-character-authoring/` とする。Skill は次を provider 間で共有する。

- runtime philosophy と person-first boundary
- existing definition の差分改善手順
- LF-normalized 8,000 character format
- 「選択の核 × 言語アイデンティティ × 状態変調」による Character Kernel
- Identity Core、Attention and Appraisal、Social Intent、Emotional Dynamics、Thinking and Action Style
- Voice Rules の Identity Invariants、Distributional Tendencies、Triggered Markers
- State Modulation、Character Priority、Minimal Reliability
- public description と relationship rubric
- official / community source と rights / privacy policy
- observation、採否、uncertainty、revision guardrail、validation result の notes 分離
- full authoring 用の generalization / voice test と seven-scenario relationship smoke test

Skill は局所的な語尾、反応、呼称頻度の修正を targeted update とし、新規作成、Character Kernel への再構成、全面改稿、事実・関係性・public description の位置付けを変える作業を full authoring とする。format、8,000 文字上限、output boundary、依頼箇所の review は両 mode で確認する。source 調査、全 rubric、Name-swap、Phrase-suppression、Voice-restoration、Unseen-scenario、Paraphrase diversity、Marker-overuse、Core-tension、Long-form retention、7 ケースの relationship smoke test は full authoring、source に依存する変更、またはユーザーが調査を求めた場合に行う。

full authoring の新しい runtime 定義は、完成返答の `Examples` や場面別台詞集を置かず、未知場面へ一般化できる生成規則で構成する。targeted update は旧 section や既存 `Examples` があることだけで全面 rewrite せず、有用な identity signal を保持する。推奨 Kernel 構造を storage parser の hard contract へ昇格せず、既存 Character を自動 migration しない。

`character-notes.md` は optional のまま扱う。targeted update では記録すべき source、material な解釈、revision guardrail がある場合だけ template から作成し、full authoring では作成して evidence と判断を記録する。

## Runtime And Validation

- `sessionKind = "character-authoring"` を使う。
- provider 固有差分は既存 Session adapter と provider skill root に閉じ込める。
- agent は catalog storage API を直接呼ばず workspace files を編集する。
- authoring runtime は stable owner を維持し、各 turn で canonical definition から snapshot を再解決する。invalid 遷移時の failure timing は `src-electron/session-runtime-service.ts` と対応 test を正本とする。
- 汎用 Session / Companion の owner と immutable snapshot 契約は `docs/design/character-storage.md` と ADR 009 を参照する。
- Editor save、storage create/update、direct file runtime snapshot は共通 format validator を使う。

## Non Goals

- `character-notes.md` の runtime 常設 prompt 注入
- Memory / Growth / unrelated Session history からの hidden rewrite
- `config.toml` からの hidden input
- user action なしの Character 自律保存
- user-selectable authoring Skill / Agent
- Notion 同期、CharacterPack Zip、asset 生成・配布、catalog metadata の色更新
- source の権利や外部情報の完全性保証

## Executable Contracts

- `scripts/tests/character-authoring-service.test.ts`: fixed Skill、provider root、file preservation、saved metadata projection
- `scripts/tests/character-editor-app.test.tsx`: unsaved draft gate、provider selection、minimal launch input
- `scripts/tests/character-definition-format.test.ts`: normalized 8,000 character boundary
- `scripts/tests/character-storage.test.ts`: create/update/direct runtime snapshot boundary
