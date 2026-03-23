# Plan

## Goal

- `GitHub Copilot` provider の `rawItemsJson` を full dump ではなく、監査で読める stable event trace に整理する
- `assistant.message_delta` や `assistant.reasoning_delta` のような大量 event で重要 event が埋もれないようにする
- bootstrap failure 時の debug metadata は保持したまま、通常 turn の監査可読性を上げる

## Scope

- `src-electron/copilot-adapter.ts` の `rawItemsJson` 保存前フィルタ
- `scripts/tests/copilot-adapter.test.ts` のフィルタ回帰テスト追加
- `docs/design/audit-log.md` / `docs/design/provider-adapter.md` の同期
- plan 記録更新

## Out Of Scope

- `Latest Command` / live step の表示改善
- Audit Log overlay の UI redesign
- provider-native slash command 対応

## Task List

- [x] Plan を作成する
- [x] keep / drop する Copilot event 種別を決める
- [x] `rawItemsJson` の stable event フィルタを実装する
- [x] 回帰テストを追加する
- [x] docs と plan 記録を更新する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/audit-log.md`
- `docs/design/provider-adapter.md`
- `docs/plans/20260323-copilot-rawitems-filtering/`

## Risks

- delta event を落としすぎると、後から failure point を追いにくくなる
- provider 側 schema 追加時に意図せず event を消す可能性がある
