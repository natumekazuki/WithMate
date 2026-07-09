# 決定

## 2026-03-31

- `docs/reviews/review-20260329-1438.md` は UI/UX review の監査ログとして残し、実行管理へ必要な項目だけを `docs/task-backlog.md` へ統合する
- review 11 件を 1:1 で backlog 化せず、実装単位として自然な 4 クラスタへ束ねる
  - `session-keyboard-a11y`: review #1 #2 #5 #11
  - `session-responsive-guardrails`: review #8 #9
  - `session-feedback-recovery`: review #3 #4 #10
  - `theme-wcag-contrast`: review #6
- review #7（1400px 以下でのレスポンシブ対応）は、既存 `#20 Session 入力エリア幅調整` の延長線上で扱うのが自然なため、新規 Local task にはせず `#20` の依存 / メモへ統合する
- review #7 を `#20` へ統合した結果、`#20` は 1400px 付近で right pane に到達できない実利用上の阻害も受け持つため、`session-responsive-guardrails` と同じ responsive 到達性クラスタの入口として `P1` へ引き上げる
- backlog 上で次の着手順が分かるよう、管理表だけでなく `## UI/UX review follow-up整理` と `## 推奨順` にも review 起点の順序を反映する
- session workspace の planning artifact に current task と next steps を記録し、repo root には plan artifact を置かない
