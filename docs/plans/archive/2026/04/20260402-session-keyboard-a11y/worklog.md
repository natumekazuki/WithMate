# Worklog

## 2026-04-02

- `docs/task-backlog.md` と `docs/reviews/review-20260329-1438.md` から次タスク候補を確認し、`session-keyboard-a11y` を選定
- 対象 UI を検索し、`src/App.tsx`、`src/session-components.tsx`、`src/home-components.tsx`、`src/CharacterEditorApp.tsx`、`src/DiffViewer.tsx` が主な変更点になる見込みと判断
- `src/a11y.ts` を追加し、dialog 用の `Escape + 初期 focus + Tab trap` と single-select / listbox 用の roving helper を実装
- `New Session`、character update provider picker、`Audit Log`、inline diff、approval chip、custom agent / skill picker、`@path` 候補、DiffViewer keyboard scroll を current UI に反映
- docs-sync 判断:
  - `docs/design/desktop-ui.md`: 更新必要。dialog keyboard / provider chip / `@path` / Diff keyboard scroll の current 挙動が変わったため
  - `docs/manual-test-checklist.md`: 更新必要。手動確認項目に modal keyboard / diff keyboard / `@path` の新挙動を追加するため
  - `docs/task-backlog.md`: 更新必要。`session-keyboard-a11y` の完了反映のため
  - `.ai_context/`: 更新不要。AI 向けの設計前提や DI ルールには変更がないため
  - `README.md`: 更新不要。入口導線やセットアップには変更がないため
- 検証: `npm run build`、`node --import tsx scripts/tests/a11y.test.ts`
- コミット: `dda92dc` `feat(session): improve keyboard accessibility`
