# Mock Window Split Plan

- 作成日: 2026-03-12
- 対象: React モックへ `Home Window` / `Session Window` 分離を反映する
- 参照:
  - `docs/design/window-architecture.md`
  - `docs/design/ui-react-mock.md`

## Goal

現在の単一 window React モックを、Issue `#2 Homeとセッションは別ウインドウにする` に沿って
`Home Window` と `Session Window` の 2 画面構成へ再設計する。
Electron の本実装ではないため、モック上では `window mode` の切り替えと `open / focus` の疑似挙動で体験を再現する。

## Task List

- [x] 現在の `App.tsx` の state を `Home` と `Session` の責務へ分割する
- [x] `Home Window` モックを実装する
- [x] `Session Window` モックを実装する
- [x] `Recent Sessions` から `Session Window` を開く疑似挙動を実装する
- [x] `New Session Launch` から新規 session を作成し、`Session Window` を開く挙動を実装する
- [x] 2-window 前提の文言とモック説明を design docs に反映する
- [x] typecheck / build で確認する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260312-mock-window-split.md`

## Design Check

- 既存 Design Doc で十分
- 実装時は `docs/design/window-architecture.md` と `docs/design/ui-react-mock.md` を正として合わせる

## Risks

- Electron の実 multi-window ではないため、モックでどこまで `別 window 感` を出すかの線引きが必要
- 既存 `App.tsx` は単一コンポーネントに状態が集中しているので、雑に分離すると差分が大きくなりやすい
- `Home` と `Session` を 1 画面内トグルで表現する場合、最終実装との差を docs へ明記しないと誤読されやすい

## Proposed Direction

- モック上は `windowMode: home | session` を持つ
- `Home Window`
  - Recent Sessions
  - Character Catalog
  - New Session
- `Session Window`
  - Current Session Header
  - Work Chat
  - Character Stream
  - Diff Viewer
- 既存の launch dialog は `Home Window` 配下へ移す
- `Recent Sessions` から開いた session は `activeSessionId` と `openedSessionIds` で疑似管理する

## Notes / Logs

- 画像表示やディレクトリ picker は今回の主目的ではないので、既存モックのまま維持する
- 実 Electron では `BrowserWindow` 管理になるが、今回は UI と導線の整理を優先する
- React モックでは `Home Window` と `Session Window` を同一ブラウザ内に並べることで、実 multi-window の責務分離を preview できる形にした
- `openedSessionIds` を導入し、Home 側で `Opened Session Windows` を見せるようにした
- `toViteFsPath` の不正な template literal を修正し、character PNG を `@fs` 経由で表示できるようにした
- `Send` はダミー表示ではなく、現在選択中 session の message / stream を更新するようにした
