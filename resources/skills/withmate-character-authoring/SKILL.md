---
name: withmate-character-authoring
description: WithMate が作成した Character authoring workspace で、自然言語の依頼から character.md と optional な character-notes.md を新規作成または改善する。
---

# WithMate Character Authoring

現在の Character directory で作業する。恒久成果物は`character.md`と、必要な場合の`character-notes.md`だけとする。

authoring指示は通常のSession messageから受け取る。起動時専用の指示欄がある前提にしない。

標準は、既存定義と会話を読み、必要な論点だけを照合し、試作・検証の結果から原因を直すcollaborative authoringである。質問票をそのままユーザーへ返さず、既に示された希望やフィードバックを引き継ぐ。確認を省略して一度に進める場合も、未確認事項を確認済みとは扱わない。

```text
research → alignment → calibration ⇄ validation
```

WithMateではCharacter filesを現在のworkspaceのcanonical filesとしてagentが直接編集する。候補版、承認、外部同期を別の保存機構へ自動投入しない。

## Mode

編集前に変更を分類する。

### Targeted update

既存の事実、関係性、public description、Characterの選択の核を変えない局所修正に使う。語尾、口癖、呼称の頻度、一つの反応規則など、変更を一つのstable sectionへ閉じられる場合が対象となる。

既存のsection構成や`Examples`があるだけではfull authoringへ広げない。依頼と競合しない有用なidentity signalを保持し、不要な全文rewriteを行わない。

### Full authoring

次のいずれかに該当する場合に使う。

- 新規Characterの作成
- 全面改稿、Character Kernelへの再構成、または複数のbehavioral sectionにまたがる変更
- 公開personaの事実、経歴、所属、活動、時期、関係性、public descriptionの位置付けを追加または変更する
- sourceに依存する判断を行う、またはユーザーが調査を求める

分類に迷うだけでfullへ広げない。変更対象が上の条件へ到達するかで判断する。

## Common Preparation

編集前に次を最後まで読む。

1. `AUTHORING_PROMPT.md`
2. `input.json`
3. `character.md`
4. 存在する場合は`character-notes.md`
5. `references/runtime-philosophy.md`
6. `references/character-format.md`
7. `references/improve-existing-character.md`

`character-notes.md` は optional である。targeted updateでは、source、materialな解釈、Likeness Anchor、revision guardrailを残す必要がある場合だけ、同梱の`templates/character-notes.md`から作成する。

## Targeted Update Workflow

1. ユーザー指示をobservable behaviorの変更へ翻訳し、変更を所有する最小sectionを特定する。
2. 既存の良かった声、距離、構文、反応、状態差をPreserveとして先に列挙する。
3. 実際の出力やフィードバックがある場合は、定義に書かれていることと通常出力に現れていることを分ける。現象、原因仮説、規則変更、別入力での確認を一組にする。
4. 必要なsectionだけを編集する。旧sectionや既存`Examples`はhard format違反ではなく、依頼に不要なら構造変更しない。
5. source調査は既定で行わない。新しい事実や解釈が必要になった場合はfull authoringに切り替える。
6. 次を検証する。
   - frontmatterと`withmate-character-v5` hard formatを維持している。
   - LF正規化後のファイル全体が8,000 Unicode code point以下である。
   - runtime behaviorとauthoring evidenceの境界を維持している。
   - 依頼箇所と、その変更が直接影響するbehaviorを確認した。
   - unrelated behavior、public facts、relationship boundaryを変えていない。
   - 口癖や呼称の抑制だけで、平常の声を無色にしていない。

## Full Authoring Workflow

Common Preparationに加えて、次を最後まで読む。

1. `references/source-and-rights-policy.md`
2. `references/authoring-rubric.md`
3. `references/review-checklist.md`

その後、次を行う。

1. 既存定義、notes、過去のフィードバックを読み、Preserve / Revise / Investigateへ分ける。
2. `character-notes.md`がなければ、同梱の`templates/character-notes.md`から作成する。
3. ユーザーが`検索不要`と指定しない限り、公式・一次情報を事実確認の中心にし、関連community sourceを公開personaの細部を発見する補助層として調査する。
4. ユーザーがすでに示した観察、希望、出力評価を聞き直さず、重要な解釈だけを1〜3論点に絞って照合する。
5. observationを、状況、最初の着眼点、評価、対人行為、感情推移、言語特徴へ分解してnotesに記録する。
6. Characterらしさを「選択の核 × 言語アイデンティティ × 状態変調」として導出し、平常時のBaseline Presenceと保護するLikeness Anchorを先に定める。
7. `character.md`を次の生成規則で構成する。
   - Baseline Presence
   - Identity Core
   - Attention and Appraisal
   - Social Intent / User Relationship
   - Emotional Dynamics and Core Tensions
   - Thinking and Action Style
   - Voice Rules（Identity Invariants、Distributional Tendencies、Triggered Markers）
   - 必要な場合のAssociation and Meme Response
   - State Modulation
   - Character Priority
   - Minimal Reliability
8. 一人称と任意の一人へ使えるユーザー基本呼称について、正確な表記、使用場面、省略方針、出やすさ、状態による語気調整を明示する。
9. 完成返答の`Examples`や場面別台詞集を新しいruntime本文へ置かない。既存例から有用なsignalを抽出する場合は、未知場面へ一般化できる生成規則へ変換する。
10. 口癖はhabitual / reactive / signatureを区別し、出現しやすい文脈と抑える文脈の両方を定める。全markerへ「まれ」「少量」「一返答一度」を機械的に付けない。
11. ネット反応が重要な場合は、連想の手掛かり、反応の入り方、話題への変形、相手の返しへの乗り方を短い採用語・構文で定める。未確認の使用歴や新しい流行は作らない。
12. observation、採否、uncertainty、revision guardrail、validation結果をnotesへ分離する。
13. LF正規化後のファイル全体が8,000 Unicode code point以下であることを実測する。
14. rubricとreview checklistを使い、次を検証する。
   - Baseline / Anchor-presence
   - Name-swap / Combination
   - Phrase-suppression
   - Voice-restoration
   - Marker-underuse / Marker-overuse
   - Unseen-scenario
   - Paraphrase diversity
   - Core-tension
   - Long-form retention
   - Multi-turn continuity / Return-to-baseline
   - Regression / Protected-trait
   - 7場面のrelationship smoke test

調整用の入力をholdoutや未見入力と呼ばない。後編集した作例、作成者が演じた仮想ユーザーとのscripted dialogue、WithMate実機の未編集出力は別々に記録する。未実施や根拠不足はpassにしない。

## Boundaries

- `character.md`と`character-notes.md`以外を編集しない。ただしworkspace instructionsがmanaged authoring fileの更新を明示した場合を除く。
- app database、packaged resource、このCharacter directory外のfileを編集しない。
- `config.toml`、Memory、unrelated Session / companion / chat historyをhidden inputとして使わない。
- Character rootへsource report、review checklist、manifest、pack directory、Zipを作らない。
- Notion同期、親・子page作成、CharacterPack Zipの作成・展開検証、asset生成・添付・配布、catalog metadataの色更新を必須処理にしない。
- `character.md`の必須frontmatterを削除しない。
- `character.md`本文へWithMate実装、prompt注入、source policy、authoring workflowの説明を書かない。
- 長いevidence、uncertainty、revision history、rejected idea、再導入を防ぐguardrailは`character-notes.md`に置く。
- 既存Characterへ自動migrationや一括rewriteを要求しない。Character Kernelは新規作成とfull authoringの推奨契約であり、legacy sectionはhard format上引き続き有効とする。
- Project側のrevision/hash、承認版の凍結、外部同期を、WithMateの新しい台帳や保存機構として追加しない。

## Final Response

次を短く報告する。

- 選択したmode
- 変更したfileとbehavior
- LF正規化後の実測文字数を含む検証
- 実施した検証の環境と、未実行・未解決の事項
- full authoringで利用できなかったsource、または出力確認ができなかった範囲
