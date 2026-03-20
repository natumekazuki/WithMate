# Decisions

## Summary

- `live run step` は coding agent の実況表示として扱い、整然さより可視性を優先する
- current baseline の改善点は維持しつつ、今回の主対象を `command_execution` 視認性と `assistantText` 未着時の進行中感へ絞る

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: pending bubble の `live run step` は整理された進捗 UI と実況 UI のどちらを優先すべきか
- 判断: 実況 UI を優先し、`command_execution` や変更対象のような意図理解に効く情報は常時表示へ戻す
- 理由: WithMate は coding agent UI であり、ユーザーは返答待ちよりも「今なにをしようとしているか」を知りたいから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-20
- 論点: current baseline のどこを維持し、どこを今回の plan でやり直すか
- 判断: `status / type` label、bucket sort、`usage` footer 集約、`errorMessage` 分離、`file_change` list 化は baseline として維持し、`command_execution` の専用強調と `assistantText` 未着時の進行中感を今回の主修正対象とする
- 理由: 既存改善の一部は有効に機能しており、問題の中心は command が「存在するが見やすくない」ことと、assistant 本文未着時の安心感不足だから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `src/ui-utils.tsx`, `docs/manual-test-checklist.md`

### 0003

- 日時: 2026-03-20
- 論点: data 整形や broader refactor を同一 plan に含めるべきか
- 判断: UI 層で完結する修正は `same-plan` とし、UI 要件を満たせない場合のみ `src-electron/codex-adapter.ts` を条件付き affected file として扱う
- 理由: 現時点では live run step 可視性改善の範囲に収まるが、event schema 変更を伴う場合は独立検証が必要になるため
- 影響範囲: `src-electron/codex-adapter.ts`（条件付き）, `docs/plans/20260320-live-run-step-realtime-visibility/plan.md`
