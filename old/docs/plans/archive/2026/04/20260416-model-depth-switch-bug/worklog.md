# 20260416 model-depth-switch-bug Worklog

## Status

- Closed

## 2026-04-16

- `src/App.tsx` の model change handler が `resolveModelSelection()` を使っており、切り替え先 model に存在しない depth を持ったまま切り替えると例外になることを確認した。
- `src/model-catalog.ts` に model change 専用の `resolveModelChangeSelection()` を追加し、model は exact match のまま depth だけ fallback させる方針で実装した。
- `scripts/tests/model-catalog-settings.test.ts` に回帰 test を追加した。
- `docs/design/model-catalog.md` は更新が必要と判断したが、この環境では `docs/design/` への書き込みが拒否されて未反映。
- 検証再実行の前提として `node_modules` が存在しないことを確認した。
- `npm ci` は install script 実行時の `spawn EPERM` で失敗したため、`npm ci --ignore-scripts` で依存だけ展開した。
- `tsx` は `esbuild` child process 起動で `spawn EPERM` になるため、`tsc` で `scripts/tests/model-catalog-settings.test.ts` と `scripts/tests/session-state.test.ts` を `.tmp-test-run/` へ JS 出力してから `node` で実行する迂回に切り替えた。
- `node .tmp-test-run/scripts/tests/model-catalog-settings.test.js` と `node .tmp-test-run/scripts/tests/session-state.test.js` は成功した。
- `npm run build` は成功した。
- local Git commit は worktree 実体の `.git/worktrees/73/index.lock` を repo 外に作ろうとして権限エラーになり失敗した。
- `git ls-remote` は `github.com:443` 接続失敗で止まり、shell からの push 経路は使えなかった。
- GitHub connector は read 系は動くが、`create_blob` など write 系操作は `user cancelled MCP tool call` で拒否され、remote commit / PR 作成も完了できなかった。
- commit / push / PR はユーザー側で引き継ぐ前提に整理し、実装差分と検証結果だけを残して plan を close した。
