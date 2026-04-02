# 20260402-memory-management-ui Plan

## 目的

- Settings Window から Memory を一覧・閲覧・削除できる最小 UI を追加する
- 対象は Session / Project / Character Memory とする
- scope は管理 UI に限定し、手動更新や抽出フロー変更は含めない

## スコープ

1. memory storage に一覧・削除 API を追加する
2. main process に memory 管理用 service / IPC を追加する
3. Settings Window に Memory 管理セクションを追加する
4. 必要な tests と docs を更新する

## 非スコープ

- Memory の手動編集 UI
- Memory 抽出タイミングや ranking policy の変更
- 新規 window 追加

## チェックポイント

- [ ] storage / service で snapshot と delete が扱える
- [ ] preload / IPC / renderer API が接続される
- [ ] Settings Window で Session / Project / Character Memory を一覧・削除できる
- [ ] build / targeted tests が通る
- [ ] docs を同期する
