# Plan

## Goal

- `New Session` dialog に `Coding Provider` 選択肢を追加する
- `Settings` の `Coding Agent Providers` を `ProviderName + checkbox` の読みやすい row UI に直す
- 既存の provider settings / model catalog / session 作成フローを壊さずに反映する

## Scope

- `src/HomeApp.tsx` の launch dialog / settings UI 更新
- 関連 CSS の調整
- `docs/design/session-launch-ui.md` と `docs/design/desktop-ui.md` の同期
- `docs/manual-test-checklist.md` の確認項目更新

## Out Of Scope

- provider credential 保存仕様の変更
- Session Window 側の provider 表示追加
- approval / model / depth の launch dialog 内調整

## Task List

- [x] Plan を作成する
- [x] New Session の provider state と選択 UI を追加する
- [x] Settings の provider toggle row を見やすい並びへ直す
- [x] docs を同期する
- [x] typecheck / build で確認する

## Affected Files

- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/session-launch-ui.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- model catalog に provider が増えた時の default provider 選択と dirty state の扱いを崩しやすい
- launch dialog で provider を先に選ぶことで、session 作成前の validation 条件が増える
