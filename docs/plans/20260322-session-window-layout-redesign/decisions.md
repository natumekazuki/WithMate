# Decisions

## Summary

- Session Window の次期 desktop layout は `1920x1080` フル表示を baseline にし、左を conversation column、右を `Character Stream` も吸収できる context rail とする 2 カラム構成で再設計する

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: `Activity Monitor` をどこに置くか
- 判断: baseline desktop では右 rail 上段へ移す
- 理由: chat 本文の縦可視域を削らずに command 実況を常時見せられるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/session-window-layout-redesign.md`

### 0002

- 日時: 2026-03-22
- 論点: artifact / run checks / operation timeline をどこで読むか
- 判断: 最新 assistant turn を読む `Turn Inspector` を右 rail 下段へ置き、message list 側は本文優先に寄せる
- 理由: 会話本文と成果物詳細の競合を減らし、wide screen の横幅を活用できるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/session-window-layout-redesign.md`

### 0003

- 日時: 2026-03-22
- 論点: responsive fallback をどこで切り替えるか
- 判断: `1400px` 未満では現在に近い縦 stack へ戻す前提で設計する
- 理由: 右 rail を維持したままでは message list の可読幅を保ちにくいため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/session-window-layout-redesign.md`, `docs/manual-test-checklist.md`

### 0004

- 日時: 2026-03-22
- 論点: `Character Stream` を将来どこへ置くか
- 判断: 右 rail の上段を `Primary Context Pane` とし、run 中は `Activity Monitor`、idle 時は `Character Stream` を主表示する host にする
- 理由: command 実況とキャラ面はどちらも補助面であり、chat 主面と切り離して同じ文脈 rail に載せるのが自然なため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/session-window-layout-redesign.md`

### 0005

- 日時: 2026-03-22
- 論点: 左右カラムの幅を固定比率にするか
- 判断: conversation column と context rail の間に draggable splitter を置き、ユーザーが左右幅を調整できるようにする
- 理由: `1920x1080` でも利用者ごとに chat と context の最適幅が異なり、固定比率では収まりきらないため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/session-window-layout-redesign.md`
