# 問題

- `docs/reviews/review-20260329-1438.md` の UI/UX review は監査ログとして残っているが、実行管理用の `docs/task-backlog.md` には未統合のまま
- review 11 件をそのまま backlog へ転記すると curated backlog の粒度を崩すため、実行対象だけを backlog task へ束ね直す必要がある
- review 起点で「次にどこから着手するか」が backlog 上で分からないため、優先順と対応関係を補助 section で明示したい
- 今回の整理内容に対応する repo plan artifacts / session workspace planning artifact が未作成

# 方針

- `docs/reviews/review-20260329-1438.md` は監査ログとして編集せず、参照元のまま残す
- `docs/task-backlog.md` は既存フォーマットを維持しつつ、実行対象だけを Local backlog として追加する
- review #7 は新規 task 化せず、既存 `#20 Session 入力エリア幅調整` の依存 / メモへ統合し、responsive 到達性クラスタの入口として `P1` 扱いへ揃える
- review-to-backlog の対応と UI review 起点の着手順は `## UI/UX review follow-up整理` で補助的に明示する
- repo plan artifacts と session workspace の planning artifact を同時に作成 / 更新して、今回の判断と current task を記録する

# TODO

1. worktree が clean であることを確認し、今回の docs-only 作業を開始する
2. review 11 件のうち backlog 化する対象を 4 クラスタ + `#20` 統合へ整理する
3. `docs/plans/20260331-review-backlog-integration/` に `plan.md` `decisions.md` `worklog.md` `result.md` を作成する
4. session workspace の planning artifact を作成 / 更新し、repo root には plan artifact を置かない
5. `docs/task-backlog.md` の管理表、`#20` の依存 / メモ、`## UI/UX review follow-up整理`、`## 推奨順`、`## 参照元` を更新する
6. diff を確認し、今回の整理内容と未コミット状態を artifacts へ反映する

# 検証方針

- `docs/task-backlog.md` の更新日が `2026-03-31` のまま維持されていることを確認する
- 管理表に Local backlog 4 件が既存フォーマットで追加され、依存 / メモに `docs/reviews/review-20260329-1438.md #...` が入っていることを確認する
- `#20 Session 入力エリア幅調整` に review #7 統合メモが追記され、管理表では `P1` ブロックへ移動していることを確認する
- `## UI/UX review follow-up整理` が追加され、review-to-backlog 対応と UI review 起点の着手順が読めることを確認する
- `## 推奨順` と `## 参照元` に今回の Local review tasks と review 文書参照が反映されていることを確認する
