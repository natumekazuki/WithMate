# 20260314 Model Catalog UI

## Goal
- Home Window から model catalog の import / export を実行できるようにする。
- catalog ファイルの選択と保存は Main Process 側 dialog に寄せる。
- import 後は active catalog revision を切り替え、Session Window が必要に応じて追従できる状態にする。

## Task List
- [x] `docs/design/model-catalog.md` に Home からの import/export 導線を追記する。
- [x] `docs/design/ui-react-mock.md` に Home toolbar の catalog actions を反映する。
- [x] Main Process に model catalog import/export file dialog API を追加する。
- [x] preload / renderer API に import/export file action を追加する。
- [x] Home Window に `Import Models` / `Export Models` ボタンを追加する。
- [x] import / export の成功失敗を最小の UI フィードバックで返す。
- [x] `typecheck` / `build` / `build:electron` で検証する。

## Affected Files
- `docs/design/model-catalog.md`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260314-model-catalog-ui.md`
- `src/withmate-window.ts`
- `src-electron/preload.ts`
- `src-electron/main.ts`
- `src/HomeApp.tsx`
- `src/styles.css`

## Risks
- file dialog の責務を renderer に持ち込むと `file://` 実行や権限周りで挙動がぶれやすい。
- import 失敗時のメッセージが雑だと、JSON 不正と I/O 失敗の切り分けがしにくい。

## Design Check
- Home Window の責務に model catalog 管理を追加するため、関連 design doc の更新が必要。

## Notes / Logs
- 2026-03-14: import は Main Process の open dialog -> JSON parse -> revision import で完結させた。
- 2026-03-14: export は active catalog を save dialog で versionless JSON として保存する形にした。
- 2026-03-14: Home toolbar に操作を寄せ、Session Window へは持ち込まない方針にした。