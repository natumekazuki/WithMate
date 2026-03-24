# Session TUI Launch Plan

## Goal

- Session Window から、その session の `workspacePath` を作業ディレクトリにした terminal を起動できるようにする
- まずは外部 terminal 起動を最小実装とし、埋め込み PTY/TUI は scope 外にする

## Scope

- main process に terminal 起動 IPC を追加する
- preload / renderer から session 単位で起動できるようにする
- Session Window に起動導線を追加する
- 実機テスト項目と関連 design doc を更新する

## Out of Scope

- Session Window 内への terminal 埋め込み
- terminal 内で起動するコマンドの固定
- macOS / Linux 向けの最適化

## Steps

1. 既存の session / workspace 解決経路と UI 差し込み位置を確認する
2. `workspacePath` を使って外部 terminal を起動する main IPC を追加する
3. Session Window に terminal 起動ボタンを追加する
4. docs / manual test を更新する
5. `npm run build` で確認する
