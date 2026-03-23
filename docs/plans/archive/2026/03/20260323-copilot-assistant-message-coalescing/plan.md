# Plan

## Goal

- Copilot の top-level `assistant.message` が複数回返る turn でも、chat UI と audit log に最後の 1 件だけでなく到着順の全文が残るようにする
- `assistant.message_delta` と `assistant.message` の混在でも二重連結せず、Codex と同じ空行区切りの assistant text を組み立てる

## Scope

- `src-electron/copilot-adapter.ts` の assistant text 累積ロジック修正
- `scripts/tests/copilot-adapter.test.ts` の回帰テスト追加
- 必要な design doc / plan 記録更新

## Out Of Scope

- Copilot raw item schema の追加変更
- Session UI デザイン変更
- artifact summary 拡張

## Task List

- [x] Plan を作成する
- [x] Copilot event から assistant text が潰れる条件を整理する
- [x] top-level `assistant.message` の coalescing を実装する
- [x] 回帰テストを追加する
- [x] docs と plan 記録を更新する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/provider-adapter.md`
- `docs/plans/20260323-copilot-assistant-message-coalescing/`

## Risks

- `assistant.message_delta` と final `assistant.message` の重複除去を誤ると本文が二重化する
- tool 配下の `assistant.message` を誤って top-level 本文へ混ぜると UI が noisy になる
