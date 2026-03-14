# Session Run Protection Plan

## Goal

- 実行中セッションが `Session Window` の close やアプリ終了で意図せず中断されにくくする。
- まずは `確認ダイアログ` で事故を減らし、その上でバックグラウンド継続可能な構成へ進める。
- 実行中セッションのライフサイクルを Main Process 基準で明文化する。

## Task List

- [x] `docs/design/session-run-lifecycle.md` を新規作成し、実行中セッションの close / quit / relaunch 方針を整理する。
- [x] `docs/design/window-architecture.md` と関連 docs に、実行中 session の close 保護責務を追記する。
- [x] Main Process に `in-flight session run registry` を追加し、どの session が実行中か追跡できるようにする。
- [x] `Session Window` を閉じる時に、対象 session が実行中なら確認ダイアログを出す。
- [x] `window-all-closed` / `before-quit` まわりを見直し、実行中 session がある場合の挙動を制御する。
- [x] 最低限の方針として `確認ダイアログ` を実装し、可能なら `Home を残して background 継続` まで入れる。
- [x] `typecheck` と `build` を通す。

## Affected Files

- `docs/plans/20260314-session-run-protection.md`
- `docs/design/session-run-lifecycle.md`
- `docs/design/window-architecture.md`
- 必要に応じて `docs/design/electron-window-runtime.md`
- `docs/design/session-persistence.md`
- `docs/design/recent-sessions-ui.md`
- `src-electron/main.ts`
- `src/HomeApp.tsx`
- `src/ui-utils.tsx`
- `src/styles.css`

## Risks

- close / quit 制御を雑に入れると、Electron の window lifecycle が不安定になりやすい。
- 実行中 registry と session persisted state がずれると、`running` のまま復帰する壊れ方が起きる。
- `app.quit()` 抑止の条件を誤ると、アプリが閉じられなくなる。
- Windows と macOS で `window-all-closed` の期待値が違うため、設計を明示しないと混乱しやすい。

## Design Check

- このタスクは session 実行ライフサイクルと close / quit 制御の追加を含むため design doc 更新が必須。
- 更新対象:
  - `docs/design/session-run-lifecycle.md`
  - `docs/design/window-architecture.md`
  - 必要に応じて `docs/design/electron-window-runtime.md`

## Notes / Logs

- 現状は `runSessionTurn()` が Main Process で動くため、`Session Window` 単体 close では直ちに止まらない。
- ただし `window-all-closed -> app.quit()` でアプリ全体が落ちると、進行中実行も巻き込まれる。
- 実装優先度としては `確認ダイアログ` を先に入れる。その次に `background 継続` を詰める。
- 今回は `inFlightSessionRuns` を Main Process に追加し、`Session Window` close では `閉じて続行` を選べるようにした。
- 全 window が閉じた時に実行中 session があれば `Home Window` を再生成し、アプリ全体の終了を避けるようにした。
- アプリ終了時は `before-quit` で確認を出し、明示的に `終了する` を選んだ場合のみ実行中処理を中断して quit する。
- 起動時に `running` のまま残っていた session は `interrupted` へ補正し、assistant message を 1 件だけ追記する。
- Home では実行中 session を上段の chip で先に開けるようにし、通常一覧とは分けて表示する。

