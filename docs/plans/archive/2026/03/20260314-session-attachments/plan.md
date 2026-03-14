# Plan

## Goal

- Session Window の composer に、picker と `@path` の両方から扱える添付導線を追加する。
- 通常ファイル/フォルダは prompt 参照情報として扱い、画像だけは Codex SDK の structured input で渡す。

## Scope

- `src/App.tsx`
- `src/app-state.ts`
- `src/styles.css`
- `src/withmate-window.ts`
- `src-electron/preload.ts`
- `src-electron/main.ts`
- `src-electron/codex-adapter.ts`
- `docs/design/prompt-composition.md`
- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Task List

- [ ] 添付データ型と IPC 境界を追加する
- [ ] Session Window に picker / chip / `@path` 解決を追加する
- [ ] CodexAdapter で file/folder/image を SDK 入力へ変換する
- [ ] design doc と manual test checklist を更新する
- [ ] typecheck / build を通す

## Affected Files

- `src/App.tsx`
- `src/app-state.ts`
- `src/styles.css`
- `src/withmate-window.ts`
- `src-electron/preload.ts`
- `src-electron/main.ts`
- `src-electron/codex-adapter.ts`
- `docs/design/prompt-composition.md`
- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- `@path` 構文が通常の文章と誤判定する可能性がある
- workspace 外参照の `additionalDirectories` 制御を誤ると SDK 側で読めない
- 画像と通常ファイルの扱いを混ぜると監査ログの見通しが悪くなる

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/prompt-composition.md`, `docs/design/provider-adapter.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ: prompt 合成と Session composer の挙動が変わるので同期更新が必要
