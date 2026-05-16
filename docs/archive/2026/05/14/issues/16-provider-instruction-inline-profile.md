# Provider instruction sync に Mate profile 本文を inline 投影する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `src-electron/mate-instruction-projection.ts`
  - `src-electron/mate-growth-apply-service.ts`
  - `src-electron/provider-instruction-target-command-service.ts`
  - `docs/design/provider-instruction-sync.md`

## Summary

現在の provider instruction sync は `mate/core.md` / `mate/bond.md` / `mate/work-style.md` の実内容を provider instruction file へ投影せず、profile file の path 参照だけを書き込んでいる。  
そのため sync 自体は成功しても、provider 側が Mate の人格・振る舞い・協調スタイルを十分に解釈できず、「成長結果が instruction file に反映されている」という体験が弱い。

## Current behavior

- `buildMateInstructionContent()` は `displayName` / `description` / `state` と `Profile Files` の path を出力する
- `core` / `bond` / `work_style` の active な内容は instruction file に直接書かれない
- provider instruction file を見ても、現在有効なキャラ定義・人格定義・振る舞い指針が明示されない
- 実行環境によっては、参照先 path が provider root 配下ではなく、provider がその path を辿れない
- 一方で `mate/core.md` / `mate/bond.md` / `mate/work-style.md` 自体は active profile item から再レンダリングされる正本 projection であり、append-only log ではない
- `forgotten` / `superseded` / `disabled` の item は section render から落ちるため、current section 全文を provider instruction へ持っていく設計は成立しうる

## Problem

- provider が読む instruction file だけでは、Mate の人格や協調スタイルが十分に伝わらない
- file path 参照ベースだと、sync 成功と実際の効き方が乖離しやすい
- ユーザーが instruction file を見ても「今どのキャラ設定が適用されているか」を把握しにくい
- 性格や振る舞いを育てても、provider への反映が弱く見え、Mate Growth の価値が伝わりにくい
- section file は現在状態の再生成結果なので、過度に要約しなくても「今の定義全文」を同期できる余地があるのに活かせていない

## Expected behavior

- provider instruction file には、`core` / `bond` / `work_style` の **現在有効な内容そのもの** を、provider が直接読める形で書き込む
- provider は外部 file を辿らなくても、instruction file だけで Mate のキャラと協調方針を解釈できる
- 出力は必要以上に圧縮せず、現在のキャラ定義・人格定義・振る舞い定義が十分分かる粒度を保つ
- ユーザーが generated block を見れば、現在の Mate 定義が一目で分かる

## Proposed scope

1. `mate-instruction-projection.ts` の `Profile Files` 出力をやめ、`core` / `bond` / `work_style` の current section content を inline projection する
2. provider 向けの見出しを、少なくとも `Character / Persona`、`Interaction Style`、`Work Style` 相当の明示的な構造へ変える
3. 単なる file path 参照ではなく、section markdown の本文が generated block に入るようにする
4. `projection_allowed = false`、`notes`、`project_digest`、absolute path、session transcript などは引き続き除外する
5. profile item が `forgotten` / `superseded` / `disabled` になったとき、次回 sync で該当内容が block から消えることを保証する
6. projection と sync output の regression test を追加し、人格定義の本文が block に実際に入ることを固定する

## Acceptance criteria

- [ ] generated instruction block に `mate/core.md` / `mate/bond.md` / `mate/work-style.md` の path 参照が残らない
- [ ] generated instruction block に、Mate の人格・対話スタイル・作業スタイルを表す section 本文が入る
- [ ] generated instruction block だけを読めば、現在の Mate のキャラ定義が十分把握できる
- [ ] `projection_allowed = false` な情報、`notes`、`project_digest`、absolute path は block に含まれない
- [ ] profile item の drop 相当更新が起きたとき、不要になった定義は次回 sync で block から消える
- [ ] projection の unit test または sync regression test で出力内容が固定される

## Notes / open questions

- `core` / `bond` / `work_style` は active item から再生成される current-state projection なので、full section inline を採っても append-only log を provider へ渡す形にはならない
- projection の入力源を rendered section markdown にするか、active profile item から provider 向け markdown を再構築するかは設計判断が必要
- provider ごとに wording を少し変える余地はあるが、まずは共通 projection の質を上げる方が優先度は高い

