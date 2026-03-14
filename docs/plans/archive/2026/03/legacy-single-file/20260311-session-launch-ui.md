# New Session Launch UI 計画

- 作成日: 2026-03-11
- 対象: 作業ディレクトリ選択と新規セッション立ち上げ UI

## Goal

`resume picker` と対になる `new session launch` 導線を定義し、
ユーザーが作業ディレクトリを選び、Provider と Character を確認して新規セッションを開始できる UI を設計する。

## Task List

- [x] 新規セッション立ち上げのユースケースを整理する
- [x] `Codex CLI` で新規起動前に行う判断を UI へ対応付ける
- [x] `New Session` UI の情報設計を作る
- [x] `Directory Picker / Launch Panel` のモック構成を決める
- [x] React モックへ反映する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-session-launch-ui.md`
- `docs/design/session-launch-ui.md`
- `docs/design/product-direction.md`
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

新規機能の UI 追加なので、`docs/design/session-launch-ui.md` を先に作成する。
少なくとも以下を固める。

- 新規セッション開始前の判断項目
- ディレクトリ選択方法
- Character / Provider / Approval の初期値表示
- `Recent Sessions` との責務分離

## Risks

- 項目を増やしすぎると wizard 化して起動が重くなる
- 項目を減らしすぎると TUI parity が崩れる
- ディレクトリ選択を前面に出しすぎると、VTuber キャラの存在感が薄くなる

## Notes / Logs

- 2026-03-11: 現時点のモックは `resume` 導線はあるが、`new session launch` 導線が未整備。
- 2026-03-11: 次の検討対象は、作業ディレクトリを選んで新規セッションを立ち上げる UI とする。
- 2026-03-11: Drawer 上部に `Launch Panel` を追加し、workspace / character / approval / start prompt の 1 画面入力で新規 session を立ち上げるモックを実装した。
- 2026-03-11: `npm run typecheck` と `npm run build` は成功した。
- 2026-03-11: Drawer 内への常設は情報密度が高すぎたため、`Launch Panel` は modal dialog へ移し、Drawer には `New Session` ボタンのみ残す方針へ修正した。
- 2026-03-11: `Start Prompt` は不自然だったため廃止し、`New Session` は器だけ作って最初の依頼はメインチャットから送る形へ修正した。
