# session-feedback-recovery plan

## 目的

- `Session` で feedback が見えにくい場面を減らし、送信ブロックと描画エラーから user が自力で回復できる状態にする
- review `#3` `#4` `#10` に対応し、live region の再通知過多も抑える

## 背景

- 現状は `composerSendability`、pending bubble、follow banner など複数箇所に live region が散っている
- `Ctrl+Enter` / `Cmd+Enter` で送信しようとしても、blocked 時は shortcut が握り潰されるだけで視覚 feedback が弱い
- `SessionPaneErrorBoundary` は右ペイン保護だけで、fallback UI に reset action が無い
- 各 renderer entry point に app-level error recovery が無く、描画クラッシュ時に window を閉じ直す以外の導線が乏しい

## 対象

- `src/App.tsx`
- `src/session-components.tsx`
- `src/session-main.tsx`
- `src/main.tsx`
- `src/character-main.tsx`
- `src/diff-main.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`

## 変更方針

1. `Session` 内の live region を棚卸しし、常時再通知が不要な箇所は live から外す
2. send blocked 時に inline feedback を確実に見せ、send button に理由を載せる
3. app-level error boundary を追加し、`retry` / `reload` 導線を持つ fallback UI を出す
4. 既存 `SessionPaneErrorBoundary` にも reset action を付け、right pane 単体回復を可能にする

## 検証

- `npm run build`
- `node --import tsx scripts/tests/a11y.test.ts`

## 完了条件

- `Ctrl+Enter` / `Cmd+Enter` blocked 時に理由が inline で見え、send button hover でも確認できる
- pending / follow / composer feedback が同時多発に読み上げられにくい構成へ整理される
- renderer error fallback に `再試行` と `再読み込み` 相当の導線が追加される
