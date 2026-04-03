# 20260404-window-placement-policy worklog

## 2026-04-04

- repo plan を作成
- window 生成位置の current 実装を確認開始
- issue `#26` の本文を確認し、要求が「カーソルのある位置を起点に新規 window を生成したい」だと整理
- `src-electron/window-placement.ts` を追加し、cursor + workArea から clamp 付き `x / y` を決める helper を実装
- `src-electron/main.ts` で `Home Window` 以外の新規 window に cursor placement を適用
- `scripts/tests/window-placement.test.ts` を追加し、通常位置 / 右下端 clamp / display より大きい window の 3 ケースを固定
- `docs/design/window-architecture.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を同期
- `.ai_context/` と `README.md` は今回の placement policy 変更では更新不要と判断
- `node --import tsx scripts/tests/window-placement.test.ts`
- `node --import tsx scripts/tests/aux-window-service.test.ts`
- `npm run build`
