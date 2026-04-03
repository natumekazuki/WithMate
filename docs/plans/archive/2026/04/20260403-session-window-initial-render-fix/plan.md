# Plan

- task: Session Window の初期表示エラーを修正する
- date: 2026-04-03
- owner: Codex

## 目的

- `#39 セッション画面が表示できない` の原因を特定し、Session Window 初期表示で error fallback に落ちる状態を解消する

## スコープ

- Session Window の renderer 初期化経路
- preload / bootstrap / projection の依存関係確認
- 必要な回帰テスト追加

## 進め方

1. 再現 commit と現行差分を確認し、初期表示で例外が出る経路を絞る
2. 原因箇所を修正し、起動時に安全な fallback へ寄せる
3. tests / docs / backlog を同期して完了確認する

## チェックポイント

- [ ] 初期表示エラーの原因を特定する
- [ ] 修正を実装する
- [ ] 回帰テストを追加する
- [ ] docs を同期する
- [ ] build と関連 test を通す
