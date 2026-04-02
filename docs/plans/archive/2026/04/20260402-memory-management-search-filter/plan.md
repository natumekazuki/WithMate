# 20260402-memory-management-search-filter Plan

## 目的

- `Memory 管理` に検索と絞り込みを追加する
- Session / Project / Character の件数が増えても目的の Memory を辿りやすくする

## スコープ

1. search / filter / sort 用の view helper を追加する
2. Settings Window の `Memory 管理` に検索 UI と filter UI を追加する
3. docs と tests を同期する

## 非スコープ

- manual update / edit UI
- backend 側 retrieval policy の変更

## チェックポイント

- [ ] global search と domain filter が使える
- [ ] Session / Project / Character ごとの追加 filter が使える
- [ ] sort を切り替えられる
- [ ] build / tests が通る
- [ ] docs を同期する
