# Decisions

## Summary

- `live run` は visibility-first を維持するが、current baseline で既に入っている label / sort / details / usage / error の改善はやり直さない
- 今回の主対象は `file_change` 可視化であり、`assistantText`・global `usage`・global `errorMessage` の責務分離を前提に進める

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: `live run step` は情報量を抑えるべきか、可視性を優先すべきか
- 判断: visibility-first を採用し、`command_execution` や対象ファイルのような意図が読める情報は常時見せる
- 理由: WithMate の Session は一般チャットではなく coding agent UI であり、ユーザーは返答待ちだけでなく「今なにをしているか」を知りたいから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-20
- 論点: visibility-first plan で何を再実装対象とみなすか
- 判断: `operationTypeLabel()` 共有、status/type label、bucket sort、`details` 折りたたみ、usage footer、error block 分離は current baseline として扱い、再設計対象から外す
- 理由: review で blocking issue はなく、課題は基礎 UI の未実装ではなく plan 側の baseline 認識ズレだと確認できたため
- 影響範囲: `docs/plans/20260320-live-run-step-visibility-first/plan.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0003

- 日時: 2026-03-20
- 論点: `agent_message`・`usage`・`errorMessage` を live step 単位で扱うべきか
- 判断: `agent_message` は `assistantText` として step list 外で扱い、`usage` と `errorMessage` は live run 全体単位のまま維持する
- 理由: current code と data shape がその責務で揃っており、今回の task はそこを崩さず pending bubble の可視性を上げることだから
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0004

- 日時: 2026-03-20
- 論点: visibility-first の再着手で最優先に詰める UI は何か
- 判断: `file_change.summary` の複数行可視化を主対象とし、改行結合テキストを scan しやすい list 表示へ寄せる
- 理由: review で「現在も visibility-first 的に弱い」差分として残っているのがここで、他の主要改善は概ね実装済みだから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
