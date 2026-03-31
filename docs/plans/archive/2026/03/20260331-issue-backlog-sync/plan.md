# 問題

- `docs/task-backlog.md` が 2026-03-30 時点の同期内容のままで、GitHub issue `#30` `#31` `#32` `#33` が未反映
- backlog は GitHub issue の完全転記ではなく curated 文書のため、issue state をそのまま `実装状況` に写さず配置と文言を調整する必要がある
- 今回の同期作業に対応する repo plan / session 用 planning artifact の plan.md が未作成

# 方針

- `gh issue list --state all` の取得結果と、ユーザーから渡された確認済み issue 詳細を正本として扱う
- `docs/task-backlog.md` は既存の構成を大きく崩さず、管理表・Memory 関連整理・推奨順・参照元だけを最小限更新する
- CLOSED の `#2` `#6` `#8` `#9` は今回も backlog 追加対象にしない
- 変更理由と分類判断は `docs/plans/20260331-issue-backlog-sync/` に記録し、コミットは行わない

# TODO

1. `docs/plans/20260331-issue-backlog-sync/` に `plan.md` `decisions.md` `worklog.md` `result.md` を作成する
2. session 用 planning artifact の plan.md を作成する
3. `docs/task-backlog.md` の更新日、管理表、Memory 関連タスク整理、推奨順、参照元、GitHub Issues 範囲を更新する
4. 変更内容と未コミット状態を artifacts に反映する

# 検証方針

- `docs/task-backlog.md` の diff で更新日が `2026-03-31` になっていることを確認する
- 新規 4 件が指定クラスタへ配置され、`#24` と `#32` の関係、Memory 関連整理への `#31` 反映、参照元の追加が入っていることを確認する
- `GitHub Issues` 範囲が `#33` まで拡張されつつ、CLOSED の `#2` `#6` `#8` `#9` が再追加されていないことを確認する
