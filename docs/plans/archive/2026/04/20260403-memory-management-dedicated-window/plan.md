# Plan

- task: Memory 管理を専用画面へ切り出す
- date: 2026-04-03
- owner: Codex

## 目的

- `#38 Memory 管理の専用画面` として、Settings 内の `Memory 管理` を独立画面へ切り出す
- `#1 独り言の API 運用` は user が reopen するまで pending 固定であることを backlog へ明記する

## スコープ

- Memory 管理 UI の専用画面化
- Home / Settings からの導線追加
- Main / preload / renderer の window 配線
- backlog / design / manual test の同期

## 進め方

1. current の Memory 管理 UI と window 構成を確認する
2. 専用画面の最小構成を設計する
3. window / renderer / navigation を実装する
4. docs / backlog / test を同期する

## チェックポイント

- [x] `#1` pending 条件を backlog に反映する
- [x] Memory 管理専用画面の構成を決める
- [x] 専用 window を実装する
- [x] docs と test を更新する
- [x] build と関連 test を通す
