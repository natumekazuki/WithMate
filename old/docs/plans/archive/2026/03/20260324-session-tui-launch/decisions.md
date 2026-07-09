# Session TUI Launch Decisions

## Decision 1

- 決定: 初回は `Session Window` 内埋め込みではなく、外部 terminal 起動にする
- 理由:
  - ユーザー要件は `workspacePath` で TUI を立ち上げられること
  - 既存 runtime には PTY / terminal host がなく、埋め込みは別テーマになる
  - main process から外部 terminal を起動するだけなら既存 window/IPC 構造に素直に乗る

## Decision 2

- 決定: UI 導線は `Session Window` の `Top Bar` に置く
- 理由:
  - session 全体の操作であり、composer 依存ではない
  - `workspacePath` を開く系の補助操作として top-level action に寄せるほうが分かりやすい

## Decision 3

- 決定: Windows では `wt.exe` を優先し、使えない場合は `pwsh.exe`、さらに fallback で `cmd.exe` を使う
- 理由:
  - TUI との相性は Windows Terminal が最もよい
  - 環境依存で `wt.exe` が無いケースもあるので fallback を持つ
