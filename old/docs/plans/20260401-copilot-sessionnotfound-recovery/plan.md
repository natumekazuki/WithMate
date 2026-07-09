# Plan

## Goal

- `GitHub Copilot` の provider session が時間経過で失効しても、`SessionNotFound` 系 error から自動復旧できるようにする
- `threadId` continuity を維持しつつ、失効済み thread だけは新規 session へ安全に切り替える

## Scope

- `src-electron/copilot-adapter.ts` の resume fallback
- `SessionNotFound` 系 message 判定 helper の追加
- 回帰テスト追加

## Out Of Scope

- UI 文言変更
- provider SDK 本体 patch
- stale connection retry 条件の全面見直し

## Task List

- [x] Plan を作成する
- [x] `SessionNotFound` 系 error の扱いを決める
- [x] `resumeSession()` 失敗時の fallback を実装する
- [x] 回帰テストを追加する
- [x] 必要な検証を実行する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`

## Risks

- 判定文字列を広げすぎると、本来 fail させるべき provider error まで握りつぶす
- fallback 後に新しい `threadId` が結果へ反映されないと、次回以降も同じ失効 thread を再利用してしまう

## Validation

- `node --import tsx scripts/tests/copilot-adapter.test.ts`: 成功
- `npm run build`: 成功

## Docs Sync

- `docs/design/`: 更新不要。理由: provider session の失効時 fallback は internal runtime fix であり、公開仕様や UI contract は変わらないため
- `.ai_context/`: 更新不要。理由: 運用ルールや repository 前提の追加変更はなく、今回の差分は test 付きの局所修正に留まるため
- `README.md`: 更新不要。理由: ユーザー向け導線や利用手順の変更ではないため
