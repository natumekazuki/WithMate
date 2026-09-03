# Character Authoring Kernel 更新計画

## Scope

ChatGPT Pro向けCharacter Authoring ProjectのCharacter Kernelを、WithMateが配布する固定`withmate-character-authoring` Skillへ移植する。配布元、authoring用template、推奨format文書、直接検証するtestを同じ契約へ揃える。

UI、IPC、DB schema、Character owner、snapshot lifecycle、provider選択、Session永続化は変更しない。参照Zipと展開物はrepositoryへ追加しない。

## Closure Plan

### CAK-1: 配布Skillの品質契約

- Accepted contract / exact anchor: ユーザー要求の「選択の核 × 言語アイデンティティ × 状態変調」、必須Kernel要素、固定返答に依存しない生成規則、9種類の検証。ADR 010のapp管理Skillをprovider固有rootへ配布する判断。
- Scope / semantic owner: `resources/skills/withmate-character-authoring/`。`SKILL.md`がmode、参照資料、workflow、boundary、最終報告を所有し、詳細は`references/`が所有する。
- Failure mode / consumer impact: 次回のAuthor / Improve Sessionへ旧authoring規則が配布され、全面作成が旧sectionと固定Examplesへ依存する。
- State transitions / failure timing: app起動後のauthoring Session準備で、CodexまたはCopilotのworkspace skill rootへ再コピーした時点。
- Direct verification: `scripts/tests/character-authoring-service.test.ts`でコピー後のSkill、必須reference、Kernel構造、検証項目、除外境界を確認する。
- Independent review trigger: none。固定resourceのコピー結果をintegration testで直接観測できる。
- Gate: ready

### CAK-2: hard format後方互換

- Accepted contract / exact anchor: `character.md`は`schema: withmate-character-v5`、空でない`name`、空でない本文、LF正規化後8,000 Unicode code point以下。旧sectionや既存`Examples`を含む定義も読み込める。
- Scope / semantic owner: hard validationは`src/character/character-definition.ts`、推奨authoring構造は固定Skillと`docs/design/character-definition-format.md`。
- Failure mode / consumer impact: 推奨Kernelの導入をparser必須sectionへ誤昇格し、既存Characterのload、保存、runtime snapshotを拒否する。
- State transitions / failure timing: create、load、update、import、direct file runtime snapshotのvalidation時。
- Direct verification: 既存の`character-definition-format`と`character-storage` testを維持して実行し、legacy bodyをparseできる既存testを残す。parserやschemaは変更しない。
- Independent review trigger: none。hard validatorを変更せず、既存testが互換性を直接観測する。
- Gate: ready

### CAK-3: 保存・起動・provider境界

- Accepted contract / exact anchor: permanent outputは`character.md`とoptionalな`character-notes.md`に限定する。Session準備はcanonical Character filesを書き直さず、同一Skillをprovider固有rootへコピーする。
- Scope / semantic owner: `src-electron/character-authoring-service.ts`の既存workspace準備と`resources/skills/withmate-character-authoring/SKILL.md`のoutput boundary。
- Failure mode / consumer impact: 起動時に既存Characterをrewriteする、またはCharacter rootへZip、source report、manifest等を生成する。
- State transitions / failure timing: provider検証後、workspace準備からSession永続化まで。
- Direct verification: `scripts/tests/character-authoring-service.test.ts`のCodex / Copilot配布、existing filesのbyte-preservation、optional notes非生成、root entries検証を実行する。
- Independent review trigger: none。既存integration testで副作用を直接観測でき、service実装は変更しない。
- Gate: ready

### CAK-4: notesへのevidence分離

- Accepted contract / exact anchor: observation、採否、uncertainty、revision guardrail、validation結果はoptionalな`character-notes.md`へ分離し、full authoringで必要な場合に作る。
- Scope / semantic owner: `resources/skills/withmate-character-authoring/templates/character-notes.md`と`buildDefaultCharacterNotes()`の同期、詳細項目はfixed Skill references。
- Failure mode / consumer impact: full authoringでKernel導出や検証結果を追跡できない、またはapp templateと配布Skill templateが食い違う。
- State transitions / failure timing: full authoring開始時のnotes初期化と、Character新規作成時のdefault notes生成時。
- Direct verification: templateと`buildDefaultCharacterNotes()`の完全一致、templateのevidence / kernel derivation / voice / revision guardrail / validation sectionをtestで確認する。
- Independent review trigger: none。生成文字列と配布resourceを直接比較できる。
- Gate: ready

## Test Design Gate

- Failure mode: 配布後Skillが新Kernelまたは必須検証を欠く。notes templateが必要な記録欄を欠く。default Character定義が旧Examples中心の推奨構造を生成する。
- Contract: ユーザー要求、ADR 010の固定Skill配布、`docs/design/character-definition-format.md`のrecommended shape。
- Consumer impact: 次回のAuthor / Improve Sessionが旧品質契約で作業し、生成規則とevidenceの追跡が不足する。
- Canonical owner: 配布後workspace Skillを観測する`character-authoring-service` integration test、template builderを観測する`character-definition-format` test。
- Observable: コピー後のファイル内容、生成したdefault definitionのsection、app templateとSkill templateの一致。
- Check layer: filesystemを含むintegration testと純粋なtemplate unit test。
- Distinctness: 既存testは配布と旧キーワードの存在だけを見ており、新Kernelの必須構造、検証集合、固定Examples非推奨を検出できない。

## Validation

1. 対象testを実行する。
2. `npm run typecheck`を実行する。
3. `npm run build`を実行する。
4. `review-test-value`のGit modeをbase commit `8303073c6808f58f597a9168d354afcc5e7c16dc`から審査対象snapshotへ適用する。
5. 最終diffに参照Zip、展開物、個人環境path、無関係変更がないことを確認する。

## Open Questions

なし。新Kernelはauthoring推奨契約として導入し、hard parser contractには昇格しない。
