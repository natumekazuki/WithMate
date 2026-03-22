# Worklog

## 2026-03-22

- `New Session` の provider 選択 UI と `Settings` の provider row 調整用 plan を作成した
- `src/HomeApp.tsx` に `New Session` の `Coding Provider` 選択 state と enabled provider 限定の chip UI を追加した
- `src/HomeApp.tsx` の `Coding Agent Providers` を `provider 名 + checkbox` の 1 行 row に組み替えた
- `src/styles.css` で launch provider chip と settings provider row の見た目を調整した
- `src/styles.css` で provider 名を左詰め、checkbox を右固定にして `Codex` と `GitHub Copilot` の縦位置が揃うように微調整した
- `src/styles.css` で `New Session` の provider chip の active 状態を強め、選択中 provider の背景色・枠線・文字色がはっきり切り替わるようにした
- `src/styles.css` で未選択 provider chip の背景と文字色も締めて、白飛びせず active / inactive の差が読み取りやすいようにした
- `docs/design/session-launch-ui.md`、`docs/design/desktop-ui.md`、`docs/design/settings-ui.md`、`docs/manual-test-checklist.md` を同期した
- `README.md` と `.ai_context/` は今回の UI 局所変更では導線・公開仕様の追加がないため更新不要と判断した
- `npm run typecheck` と `npm run build` を通した

## Commit

- `f6850da` `feat(copilot): add minimal provider integration`
  - `New Session` の provider choice chip、`Settings` の provider row 整理、関連 docs/test を同一コミットで反映した
