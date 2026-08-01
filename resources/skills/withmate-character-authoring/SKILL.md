---
name: withmate-character-authoring
description: WithMate が作成した Character authoring workspace で、自然言語の依頼から character.md と optional な character-notes.md を新規作成または改善する。
---

# WithMate Character Authoring

現在の Character directory で作業する。恒久成果物は `character.md` と、必要な場合の `character-notes.md` だけとする。

authoring 指示は通常の Session message から受け取る。起動時専用の指示欄がある前提にしない。

## Mode

最初に変更を分類する。

### Targeted update

語尾、口癖、短い例、局所的な反応など、既存の事実、関係性、profile の位置付けを変えない小さな修正に使う。

### Full authoring

次のいずれかに該当する場合に使う。

- 新規 Character の作成
- 全面改稿または複数の behavioral section にまたがる変更
- 公開personaの事実、経歴、所属、活動、時期、関係性、public description の位置付けを追加または変更する
- source に依存する判断を行う、またはユーザーが調査を求める

分類に迷うだけで full に広げない。変更対象が上の条件へ到達するかで判断する。

## Common Preparation

編集前に次を最後まで読む。

1. `AUTHORING_PROMPT.md`
2. `input.json`
3. `character.md`
4. 存在する場合は `character-notes.md`
5. `references/runtime-philosophy.md`
6. `references/character-format.md`
7. `references/improve-existing-character.md`

`character-notes.md` は optional である。targeted update では、source、material な解釈、revision guardrail を残す必要がある場合だけ、同梱の `templates/character-notes.md` から作成する。

## Targeted Update Workflow

1. ユーザーが求める observable behavior と、それを所有する最小 section を特定する。
2. 依頼と競合しない既存の有用な判断を残し、必要な section と examples だけを編集する。
3. source 調査は既定で行わない。新しい事実や解釈が必要になった場合は full authoring に切り替える。
4. 次の共通検証を行う。
   - frontmatter と `withmate-character-v5` format を維持している。
   - LF 正規化後のファイル全体が 8,000 文字以内である。
   - runtime behavior と authoring evidence の境界を維持している。
   - 依頼箇所と、その変更が直接影響する examples を確認した。
   - unrelated behavior、public facts、relationship boundary を変えていない。

## Full Authoring Workflow

Common Preparation に加えて、次を最後まで読む。

1. `references/source-and-rights-policy.md`
2. `references/authoring-rubric.md`
3. `references/review-checklist.md`

その後、次を行う。

1. `character-notes.md` がなければ、同梱の `templates/character-notes.md` から作成する。
2. ユーザーが `検索不要` と指定しない限り、source policy に従って調査する。
3. public profile bio、relationship、reaction、voice、examples を一つの runtime definition として整える。
4. source quality、uncertainty、rights-sensitive な判断、material な revision を notes に記録する。
5. LF 正規化後のファイル全体が 8,000 文字以内であることを実測する。
6. rubric と review checklist の全項目、7 ケースの Relationship smoke test を確認する。

## Boundaries

- `character.md` と `character-notes.md` 以外を編集しない。ただし workspace instructions が managed authoring file の更新を明示した場合を除く。
- app database、packaged resource、この Character directory 外の file を編集しない。
- 無関係な session、companion、chat history から事実や関係性を推測しない。
- Character root に source report、review checklist、manifest、pack directory、Zip を作らない。
- `character.md` の必須 frontmatter を削除しない。
- `character.md` 本文へ WithMate 実装、prompt 注入、source policy、authoring workflow の説明を書かない。
- 長い evidence、uncertainty、revision history、rejected idea、do-not-reintroduce は `character-notes.md` に置く。

## Final Response

次を短く報告する。

- 選択した mode
- 変更した file と behavior
- LF 正規化後の実測文字数を含む検証
- 未解決の質問または、full authoring で利用できなかった source
