# Worklog

## Timeline

### 0001

- 日時: 2026-03-20
- チェックポイント: Plan 作成
- 実施内容: Session message list の条件付き自動追従用 plan を作成し、末尾追従と位置維持を user intent ベースで切り替える方針を定めた
- 検証: 未実施
- メモ: 次は現行の auto scroll 実装を確認し、閾値と新着通知導線の要否を詰める
- 関連コミット:

### 0002

- 日時: 2026-03-20
- チェックポイント: current baseline 反映
- 実施内容: 現行 `src/App.tsx` の常時末尾追従、follow / off state 不在、`liveRun.steps` の length 依存、CSS 状態表現なしを確認し、plan / decisions を具体化した
- 検証: 未実施
- メモ: follow 判定は bottom gap `80px`、step 更新は `status / summary / details` まで含める方針、`新着あり` 導線は必要とする方針で整理した
- 関連コミット:

### 0003

- 日時: 2026-03-20
- チェックポイント: follow mode 実装
- 実施内容: `src/App.tsx` に条件付き scroll follow mode を実装し、`selectedSession.id` 切替時の follow / unread reset、bottom gap `80px` による follow ON/OFF、`assistantText` / pending / live run step 更新の追従判定、`新着あり` / `読み返し中` banner と `末尾へ移動` 導線を追加した
- 検証: 未実施
- メモ: `liveRun.steps` は `status / summary / details` を含む scroll signature で判定する。手動スクロールで 80px を超えたときに follow OFF へ落ちることを実機で確認する
- 関連コミット:

### 0004

- 日時: 2026-03-20
- チェックポイント: first commit
- 実施内容: `src/App.tsx` / `src/styles.css` / `docs/design/desktop-ui.md` / `docs/manual-test-checklist.md` をまとめてコミットし、条件付き scroll follow mode の実装と関連 docs の更新を確定した
- 検証: `npm run typecheck` pass / `npm run build` pass / review: 重大指摘なし、実機確認の軽微なテストギャップあり
- メモ: 1件目のコミット hash は `549687f64364a65c3ddd706a986cb97e6f5fbd04`
- 関連コミット: `549687f64364a65c3ddd706a986cb97e6f5fbd04` / `fix(session-window): 条件付き scroll follow mode を追加`

## Open Items

- なし
