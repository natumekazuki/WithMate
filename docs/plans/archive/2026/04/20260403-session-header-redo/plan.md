# Plan

- task: Session header レイアウトを取り消して再設計する
- date: 2026-04-03
- owner: Codex

## 目的

- 直近の `right pane 専用 header` 修正コミットを取り消す
- user 指定の構成
  - 左: chat + `Action Dock` で高さを全面使用
  - 右: header + `Monologue` などの context pane
  - header は通常 title だけ表示し、click で左端まで伸びて全ボタンを出す
に合わせて再実装する

## スコープ

- 直近 `#37` 修正コミットの revert
- Session layout / header の再実装
- 関連 docs / test / backlog の同期

## 進め方

1. 直近 `#37` 修正コミットを revert する
2. user 指定レイアウトへ再設計する
3. renderer / style / docs を更新する
4. build と関連 test を通す

## チェックポイント

- [x] 直近 `#37` 修正コミットを取り消す
- [x] 新しい header / layout を実装する
- [x] docs と test を更新する
- [x] build と関連 test を通す
