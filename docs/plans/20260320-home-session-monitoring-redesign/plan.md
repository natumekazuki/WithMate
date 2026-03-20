# Plan

## Goal

- Home を 3 カラム前提から見直し、「左 = `Recent Sessions` / 右 = `SessionMonitor` または `Characters`」の 2 カラムへ再整理する
- `SessionMonitor` には「実際に `SessionWindow` を開いている session」だけを表示し、renderer 内の全件派生ではなく main process の truth source に合わせる
- 右ペインは segmented toggle / tab-like 2 択で排他的に切り替え、初期表示は `SessionMonitor` とする
- 現 reopen では right pane の重複 heading を外し、empty state を説明文ではなく簡潔な状態表示へ寄せる
- 現 reopen では `SessionMonitor` のスクロールを session list と同型の scroll container 設計へ寄せ、session 増加時も確実に縦スクロールできる状態へ戻す
- 既存の左右 collapse / slim collapsed rail は今回 target から外し、Home の主導線を 2 カラムへ収束させる
- 薄い IPC / preload bridge と Home renderer / docs sync の局所変更に留め、same-plan で完結できる粒度を維持する

## Scope

- Home Window の 2 カラム再構成
- 右ペインの `SessionMonitor` / `Characters` 排他的切替
- main process の `sessionWindows` を truth source にした open session window id 取得 / 購読 bridge
- `SessionMonitor` の source を「検索結果に含まれる session × open session window ids」へ切り替える整理
- Home の右ペイン初期値、レイアウト比率、empty state、search follow の定義
- `src/HomeApp.tsx` 上で組み立てている `monitorBaseEmptyMessage` / `monitorRunningEmptyMessage` / `monitorCompletedEmptyMessage` の簡素化
- segmented toggle と二重化している pane 内 top heading の削除
- `SessionMonitor` を list 自体が `overflow: auto` を持つ構成へ寄せる scroll container 再整理
- current reopen は Home renderer / Home CSS / manual checklist への局所更新に閉じ、既存の thin bridge / 2 カラム / segmented toggle は維持する
- 既存の 3 カラム / collapse 前提 design doc と manual test 項目の更新方針整理
- active plan artefact と session workspace `plan.md` の更新

## Out of Scope

- Session schema / DB schema への window open state 追加
- Session Window 自体の UI 変更
- Character Editor の UI 変更
- 右ペイン選択状態の永続化
- 既存の session list 取得順 `last_active_at DESC` の変更
- Home 以外へ広げる汎用 window registry の再設計
- 今回 target から外した左右 collapse UX の改善 / 復活

## Confirmed Current State

- 現在の Home は「左 `Recent Sessions` / 右 `SessionMonitor` または `Characters`」の 2 カラムへ戻っており、right pane は segmented toggle で排他的に切り替える構成になっている
- `SessionMonitor` の source は open session window ids と検索結果の交差集合へ切り替え済みで、open session truth source は既存 bridge で renderer へ渡せている
- open session truth source は `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` であり、current reopen では main / preload 側の追加変更は不要
- DB / Session schema に window open state は無く、current reopen でも永続層追加なしを維持する
- 左右 collapse / slim collapsed rail は現 target から既に外れており、current reopen でも復活させない
- `docs/design/desktop-ui.md` と `docs/design/home-ui-brushup.md` は 2 カラム target に同期済みで、current reopen の docs 影響は `docs/manual-test-checklist.md` と plan artefact が中心になる
- `SessionMonitor` の empty state 文言は `src/HomeApp.tsx` の `monitorBaseEmptyMessage` / `monitorRunningEmptyMessage` / `monitorCompletedEmptyMessage` で組み立てている
- right pane 内の `Session Monitor` / `Characters` 見出しは `src/HomeApp.tsx` に直書きされており、上部 segmented toggle とラベルが二重化している
- scroll 設計は session list が list 自体に `overflow: auto` を持つ一方、monitor は section wrapper 側に scroll を持たせており、height / min-height / overflow の伝播が不安定な可能性が高い

## Recommended Approach

- 推奨案: main process の `sessionWindows` から open session window ids を出す薄い IPC / preload bridge を追加し、Home は 2 カラムへ戻したうえで右ペインを segmented toggle による `SessionMonitor` / `Characters` 排他表示へ切り替える
- 採用理由:
  - `SessionMonitor` の truth source を既存 runtime state に合わせられ、DB / schema 拡張なしで要件を満たせるため
  - `Recent Sessions` を左主面に戻し、右側を補助ペインへまとめる方が Home の情報密度と視線移動が安定するため
  - collapse UX を今回 scope から外せるため、変更範囲を Home レイアウト、薄い bridge、docs sync に絞りやすいため
  - segmented toggle は排他的な 2 機能切替を最短距離で表現でき、tab-like な期待と一致しやすいため

## Design Direction

- 左カラムの `Recent Sessions` は Home の主面として維持し、session card list の resume 導線を担う
- 右ペインは `SessionMonitor` / `Characters` の 2 択で同じ面積を共有し、同時表示しない
- 起動時の右ペイン初期値は `SessionMonitor` とし、Home を開いた直後に monitoring 情報が見える状態を既定とする
- `SessionMonitor` は「open な SessionWindow を持つ session」だけを表示し、renderer 内での status 派生全件表示には戻さない
- `SessionMonitor` の表示対象は、open session window ids と `Recent Sessions` の検索結果を交差させた集合に揃える
- `SessionMonitor` の empty state は説明文を増やさず、状態だけが即読できる簡潔な表示に留める
- どちらの pane を見ているかは segmented toggle で判別できる前提とし、pane 内最上部へ `Session Monitor` / `Characters` の重複 heading は置かない
- `SessionMonitor` の scroll は session list と同様に list 自体を scroll container とし、wrapper 側へ不安定な overflow を持たせない
- `Characters` は collapse ではなく right-pane toggle の片側へ移し、search / empty / `Add Character` 導線は pane 内で完結させる
- layout 比率は `Recent Sessions : right pane = 6 : 4` を目安にし、極端に右が細くならない範囲でレスポンシブ調整する

## Acceptance Criteria

### 1. open session window の truth source を thin bridge で renderer へ渡せる

- `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` を truth source として、open session window ids を renderer から参照できる
- 初期描画時に open session window ids を取得できる API を追加する
- `SessionWindow` の open / close に追従できる購読 API または等価の更新通知を追加する
- bridge は preload 経由で公開し、renderer が main process 実装へ直接依存しない
- DB / Session schema に window open state を追加しない
- truth source の追加は same-plan の薄い runtime bridge に留め、汎用 window registry 再設計へ広げない

### 2. Home は 2 カラム構成を基準にする

- Home レイアウトは「左 = `Recent Sessions` / 右 = `SessionMonitor` または `Characters`」の 2 カラムを基準にする
- 既存の 3 カラム構成は target から外す
- 左右 collapse / slim collapsed rail は今回 target から外し、常時 2 カラム前提で整理する
- 比率は `Recent Sessions : right pane = 6 : 4` を目安にし、主面が左にあることが視覚的に明確である
- `Recent Sessions` は引き続き resume picker の本体であり、session card list の主導線を維持する

### 3. 右ペインは `SessionMonitor` / `Characters` の排他的切替にする

- 右ペイン上部に segmented toggle または tab-like 2 択 UI を置き、`SessionMonitor` / `Characters` を切り替えられる
- 2 ペインは同時表示せず、常にどちらか一方だけを表示する
- 初期表示は `SessionMonitor` とする
- 切替 UI は「どちらが現在選択中か」が一目で分かる見た目にする
- segmented toggle が active pane を示すため、pane 内 top heading に同名ラベルを重ねない
- same-plan では選択状態の永続化を行わず、renderer local state のみで扱う

### 4. `SessionMonitor` は open な `SessionWindow` を持つ session だけを表示する

- `SessionMonitor` の source は open session window ids と `filteredSessionEntries` の交差集合に限定する
- `filteredSessionEntries` 全件を monitor に出す現在の実装は target では採用しない
- open session window を持たない session は、`Recent Sessions` には残ってよいが `SessionMonitor` には表示しない
- `SessionMonitor` row は既存の session 再開 / フォーカス導線を壊さず、対象 session へ戻れる shortcut を維持する
- search 中は `Recent Sessions` と同じ検索条件に追従し、monitor と list の表示対象が乖離しない
- open session が 0 件のときは右ペイン内で空状態を明示する
- empty state は「開いている Session Window はまだないよ。セッションを開くとここに出るよ。」のような説明文を採らず、簡潔な状態表示に留める
- session 件数が増えたときは `SessionMonitor` list 自体が縦スクロールし、wrapper 側の高さ伝播に依存しない

### 5. `Characters` は右ペインのもう片側へ移し、collapse 前提を外す

- `Characters` は right-pane toggle で選んだときだけ表示する
- 既存の collapse button / slim rail / collapsed 中 action 制御は今回 target から外す
- `Characters` を選択したときは、既存の search / list / empty state / `Add Character` 導線を pane 内で維持する
- `SessionMonitor` から `Characters` に切り替えても、左の `Recent Sessions` 主面は不変である

### 6. docs を 2 カラム target へ再同期する

- `docs/design/desktop-ui.md` は Home を 2 カラム構成として説明し、右ペインの排他的切替を current target として同期する
- `docs/design/home-ui-brushup.md` は 3 カラム / slim collapsed rail 前提を外し、open session truth source と segmented toggle 前提へ更新する
- `docs/manual-test-checklist.md` は 3 カラム / collapse 前提の Home 項目を、2 カラム / right-pane toggle / open session truth source の確認項目へ更新する

### 7. Validation を新 target に合わせて更新する

- 実装後は `npm run typecheck` / `npm run build` を再実行する
- manual test では少なくとも次を確認できるようにする
  - `SessionMonitor` に open な `SessionWindow` を持つ session だけが出ること
  - SessionWindow を開閉したとき monitor 表示が追従すること
  - Home 起動時の右ペイン初期値が `SessionMonitor` であること
  - `SessionMonitor` / `Characters` toggle が排他的に切り替わること
  - pane 内 top heading が無くても segmented toggle だけで active pane を判別できること
  - `SessionMonitor` empty state が説明文ではなく簡潔な状態表示になっていること
  - `Recent Sessions` と `SessionMonitor` が同じ検索条件に追従すること
  - `SessionMonitor` に多数の session があるとき、右ペイン内で list が縦スクロールすること
  - Home が 2 カラム構成で、3 カラム / slim collapsed rail が残っていないこと
  - `Characters` 側の search / empty / `Add Character` 導線が toggle 後も維持されること
  - Home 専用 CSS 変更が Session Window 側へ波及していないこと

## Same-plan / New-plan Boundary

- 判定: `same-plan`
- 理由:
  - 変更の主軸は Home renderer、Home CSS、main/preload の薄い bridge、design doc、manual test に閉じている
  - open session の truth source は既存の `sessionWindows` を使え、DB / schema 変更なしで要件を満たせる
  - 右ペイン toggle と 2 カラム化は既存 Home redesign の refinement であり、目的・変更範囲・検証軸が連続している
- same-plan に含めるもの:
  - `src-electron/main.ts` の open session window ids 取得 / 購読 bridge 追加
  - `src-electron/preload.ts` と renderer 側型定義の更新
  - `src/HomeApp.tsx` の 2 カラム化と right-pane toggle 導入
  - `src/styles.css` の Home 専用 layout / toggle 調整
  - `docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / `docs/manual-test-checklist.md` の再同期
- `new-plan` へ分けるもの:
  - DB / Session schema へ window open state を保存する変更
  - 右ペイン選択状態の永続化
  - Home 以外でも使う汎用 window registry / event bus の再設計
  - SessionWindow / 通知 / tray まで含めた監視 UX の拡張
- リファクタ判定:
  - 判定: `same-plan`
  - 理由: thin IPC bridge、2 カラム化、right-pane toggle、collapse target の整理はすべて同一 Home redesign の完了条件に直結するため
  - 想定影響範囲: `src-electron/main.ts`, `src-electron/preload.ts`, `src/renderer-env.d.ts`, `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`
  - 検証観点: open session truth source、2 カラム layout、初期タブ、排他的切替、search follow、collapse 除外、docs/manual 更新

## Task List

- [x] Plan を作成する
- [x] 現行 Home の session chip / session card / character panel の責務を整理する
- [x] `Recent Sessions` の state precedence / badge / sort / card 情報設計を確定する
- [x] `running / interrupted` chip の shortcut 方針を確定する
- [x] `Characters` collapse UX と same-plan / new-plan 境界を確定する
- [x] Home UI 実装を更新する
- [x] design doc / manual test を更新する
- [x] repo 検証（`npm run typecheck` / `npm run build`）を完了する
- [x] quality-reviewer の確認結果を artefact へ反映する
- [x] refinement research を same-plan 判定として plan に反映する
- [x] `src/HomeApp.tsx` を左 monitor / 中央 sessions / 右 characters の 3 カラムへ再構成する
- [x] 左 monitor panel の grouping と collapse を実装する
- [x] 現行 chip row を monitor panel へ統合し、独立 row を廃止する
- [x] `docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / `docs/manual-test-checklist.md` を 3 カラム target に同期する
- [x] refinement 反映後に `npm run typecheck` / `npm run build` を再実行する
- [x] slim collapsed rail follow-up を反映する
- [x] 新 research を same-plan 判定として active plan artefact に反映する
- [x] `src-electron/main.ts` に open session window ids の取得 / 購読 bridge を追加する
- [x] `src-electron/preload.ts` / `src/withmate-window.ts` へ renderer bridge を追加する
- [x] `src/HomeApp.tsx` を 2 カラム化し、右ペイン `SessionMonitor` / `Characters` toggle を導入する
- [x] `SessionMonitor` source を open session window ids ベースへ差し替える
- [x] 既存の左右 collapse / slim collapsed rail 実装を今回 target から外し、関連 UI / state / 文言を整理する
- [x] `docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / `docs/manual-test-checklist.md` を 2 カラム target へ再同期する
- [x] 新 target 反映後に `npm run typecheck` / `npm run build` を再実行する
- [x] `src/HomeApp.tsx` の `SessionMonitor` empty state を簡潔化し、pane 内重複 heading を外す
- [x] `src/styles.css` を session list と同型の monitor scroll container 構成へ寄せる
- [x] `docs/manual-test-checklist.md` に empty state / 重複 heading 非表示 / monitor scroll の確認観点を追記する
- [ ] 2 カラム / right-pane toggle / open session truth source 追加分の manual test を実施し、結果を artefact へ反映する
- [ ] commit / archive 前の最終クローズ確認を完了する

## Completion State

- 初回 same-plan 実装: 完了
- 3 カラム refinement 実装: 完了
- slim collapsed rail follow-up: 完了
- 旧 target 向け docs sync / repo 検証 / artefact sync: 完了
- 今回 research の same-plan 判定反映: 完了
- 現 target 向け implementation: 完了
- 現 target 向け docs sync: 完了
- 現 target 向け repo 検証: 完了
- 現 reopen planning update: 完了
- 現 reopen implementation: 完了
- 現 reopen manual checklist sync: 完了
- 現 reopen repo 検証: 完了
- manual test: 未完了
- commit / archive: 未実施

## Affected Files

- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/manual-test-checklist.md`
- `docs/plans/20260320-home-session-monitoring-redesign/plan.md`
- `docs/plans/20260320-home-session-monitoring-redesign/decisions.md`
- `docs/plans/20260320-home-session-monitoring-redesign/worklog.md`
- `docs/plans/20260320-home-session-monitoring-redesign/result.md`
- `plan.md`

## Risks

- open session window ids の更新通知が不足すると、`SessionMonitor` が stale な表示になる
- `sessionWindows` の open / close ライフサイクルと renderer 購読の接続がずれると、一時的な表示ズレが起きる
- `Recent Sessions` と `SessionMonitor` の source 交差条件が曖昧だと、search 中に右ペインだけ古い対象を残す
- pane 内 heading を外した結果、toggle の selected state が弱いと active pane が分かりにくくなる
- monitor scroll container を組み替える際に min-height / flex 伝播を誤ると、右ペイン全体が伸びるだけで list がスクロールしない
- `Characters` collapse 前提の docs / manual test を更新しないと、現 target と検証軸が乖離する
- Home 専用 CSS を shared selector に混ぜると Session Window 側へ style bleed する

## Validation

- baseline:
  - `npm run typecheck` pass（旧 target では確認済み）
  - `npm run build` pass（旧 target では確認済み）
- 現 target 反映後の再確認:
  - `npm run typecheck` pass
  - `npm run build` pass
  - manual test:
    - open session window のみ monitor 表示
    - SessionWindow open / close 追従
    - 起動時右ペイン `SessionMonitor`
    - segmented toggle による排他的切替
    - pane 内重複 heading 非表示
    - empty state 簡潔化
    - `Recent Sessions` と `SessionMonitor` の search follow
    - monitor list の縦スクロール
    - 2 カラム / 6:4 目安 / 3 カラム非残存
    - `Characters` の search / empty / `Add Character` 導線維持
    - Home CSS の no-bleed

## Design Doc Check

- 状態: 現 target に同期済み
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`
- docs-sync 判定:
  - `docs/design/`: 更新済み
  - `.ai_context/`: 更新不要
  - `README.md`: 更新不要
- メモ:
  - Home は 2 カラム target として同期する
  - 右ペインは `SessionMonitor` / `Characters` の排他的切替とする
  - `SessionMonitor` の truth source は `sessionWindows` ベースの open session window ids とする
