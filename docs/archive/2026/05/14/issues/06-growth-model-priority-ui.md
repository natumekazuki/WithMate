# Mate Growth Settings の Growth Model Priority UI を purpose-scoped / catalog-aware にする

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug / UX / Validation
- Related:
  - `src/settings/SettingsContent.tsx`
  - `src/mate/mate-state.ts`
  - `src-electron/mate-storage.ts`
  - `src-electron/mate-memory-generation-runner.ts`
  - `src-electron/main.ts`
  - `docs/design/mate-growth-engine.md`
  - `docs/design/mate-storage-schema.md`
  - `scripts/tests/home-components.test.tsx`
  - `scripts/tests/mate-storage.test.ts`

## Summary

`Settings > Mate Growth Settings > Growth Model Priority` が、current runtime / design に対して自由すぎる。  
purpose を各 row で変更でき、Provider / Model / Depth は free text、row の追加 / 削除もできるが、runtime は実際には `memory_candidate` しか読んでいない。

このため、UI で保存できる内容と実際に効く設定の範囲が一致していない。

## Current behavior

- `src/settings/SettingsContent.tsx`
  - purpose は row ごとの `select`
  - Provider / Model / Depth は `input type="text"`
  - Add / Remove で row 数を自由に変えられる
- `src-electron/mate-storage.ts`
  - purpose は enum 検証する
  - provider / model / depth は「空でない文字列」までしか検証しない
- `src-electron/mate-memory-generation-runner.ts`
  - `purpose === "memory_candidate"` の row だけを使う
  - depth は未知の値でも `DEFAULT_REASONING_EFFORT` へ fallback する
- `src-electron/main.ts`
  - Growth 用 provider id の収集も `memory_candidate` だけを見る

## Problem

- `profile_update` / `project_digest` を UI で編集できても、current runtime では実質未使用
- Provider / Model / Depth が model catalog と整合しない値でも保存できる
- depth の typo や未知値が保存されても、実行時に silently fallback しうる
- purpose-fixed の設定に見えず、row の追加 / 削除 / purpose 変更で意図しない構成を作れてしまう
- docs の「purpose ごとの fixed priority list」という表現と、現在の単一グローバル list editor が噛み合っていない

## Investigation notes

- design 上は `purpose = memory_candidate | profile_update | project_digest` の固定カテゴリを持つ
- ただし design 文書だけでは、「各 purpose 1 件固定」なのか「purpose ごとに複数候補を持てる」のかまでは UI として固定されていない
- 一方で current runtime は `memory_candidate` しか使っていないため、少なくとも今の UI は先行しすぎている

## Proposed scope

1. current runtime に合わせて、Growth Model Priority UI を purpose-scoped に整理する
2. Provider / Model / Depth は free text をやめ、model catalog ベースの選択 UI にする
3. unsupported purpose は hidden / disabled / read-only のいずれかで明示する
4. storage / IPC 側でも、catalog と supported purpose に沿った validation を追加する
5. Add / Remove の可否は方針を決めて揃える
   - 各 purpose 1 件固定なら Add / Remove をなくす
   - purpose ごとの fallback 候補を許すなら、purpose 自体は固定し、purpose 単位で row を追加する

## Acceptance criteria

- [ ] purpose は row ごとの自由変更ではなく、UI 構造または section で固定される
- [ ] Provider は既知 provider からしか選べない
- [ ] Model は選択中 provider の catalog からしか選べない
- [ ] Depth は選択中 model の reasoning effort からしか選べない
- [ ] current runtime で未使用の purpose は「効く設定」に見えない
- [ ] invalid depth / provider / model を persistence layer で保存できない
- [ ] Settings UI test と storage test が新しい制約を固定する

## Notes / open questions

- product として本当に必要なのが「purpose ごとに 1 row 固定」か「purpose ごとの fallback list」かは先に決めたい
- ただしどちらの方針でも、current の free text + global add/remove + purpose editable row は不整合


