# Plan

- task: Session Window の input responsiveness を改善する
- date: 2026-04-13
- owner: Codex

## 目的

- Session Window の typing 中に preview 解決・`@path` search・session lookup が競合しすぎないようにして、入力遅延を下げる

## スコープ

- `src/App.tsx`
- `src-electron/main-query-service.ts`
- `src-electron/composer-attachments.ts`
- `scripts/tests/main-query-service.test.ts`
- `docs/manual-test-checklist.md`

## チェックポイント

- [x] plain text draft では preview を main へ問い合わせず local empty preview へできる
- [x] `@path` 編集中と IME composing 中の preview / search 発火を絞る
- [x] main 側で session lookup を対象 session clone に限定する
- [x] path 参照なし preview 早期 return と lightweight lookup の根拠を test で押さえる
- [x] user-facing 条件変更を manual checklist へ反映する

## 検証結果

- `npm run test`: fail (`scripts/tests/session-storage.test.ts` の assertion failure と `scripts/tests/settings-ui.test.ts` の export 不整合で失敗。今回変更した `scripts/tests/main-query-service.test.ts` 単体は pass)
- `npm run typecheck`: fail (repo 既存の `scripts/tests/app-settings-storage.test.ts` など広範囲の型エラーが継続。変更ファイルに絞った確認では追加エラーなし)
- `npm run build`: pass

## 完了メモ

- Session composer で path 参照が無い draft は preview を即 empty にし、IME composing 中と `@path` 編集中の preview / search 発火を絞って debounce を調整した
- main query service は path 参照なし preview の早期 return と対象 session のみ clone する lightweight lookup に寄せた
- composer attachment 解決の並列化、`scripts/tests/main-query-service.test.ts` の回帰テスト追加、`docs/manual-test-checklist.md` の `@path` 条件更新まで反映した
