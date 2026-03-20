# Worklog

## Timeline

### 0001

- 日時: 2026-03-20
- チェックポイント: Plan 作成
- 実施内容: Home の `Recent Sessions` を monitoring 対応へ再設計する plan を作成し、実行中 session を card 一覧へ戻す方針と `Characters` collapse を task に含めた
- 検証: 未実施
- メモ: 次は session chip / card / character panel の責務を整理し、最終的な情報優先度を確定する
- 関連コミット:

### 0002

- 日時: 2026-03-20
- チェックポイント: review 反映で plan 補強
- 実施内容:
  - current Home の事実関係を plan へ明文化した
  - Home 用 state precedence / badge ルール、card sort ルール、card 表示情報、chip shortcut 方針を確定した
  - `Characters` collapse の default / state / `Add Character` 導線、empty / search state、manual test 追加観点、same-plan / new-plan 境界を追記した
  - session workspace の `plan.md` を current task / next steps ベースで更新対象に含めた
- 検証: 文書更新のみ
- メモ: 次は implementation 前提の docs sync 範囲を保ったまま、`src/HomeApp.tsx` と `src/styles.css` の局所変更へ落とし込めるかを確認する
- 関連コミット:

### 0003

- 日時: 2026-03-20
- チェックポイント: same-plan 実装と docs sync
- 実施内容:
  - `src/HomeApp.tsx` で Home の session 表示を単一 card list + shortcut chip row に戻し、badge precedence / sort / summary 表示を plan どおり反映した
  - `Characters` panel に default open の collapse / expand を追加し、collapsed 時に session 側へ面積を返す layout modifier を入れた
  - `src/styles.css` を Home 専用 modifier に寄せて調整し、`docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / `docs/manual-test-checklist.md` / plan artefact を同期した
- 検証: 未実施（user 指示により `npm run typecheck` / `npm run build` はこのターンでは未実行）
- メモ: 次は typecheck / build と manual test 追加項目の実施結果を plan artefact へ反映する
- 関連コミット:

### 0004

- 日時: 2026-03-20
- チェックポイント: repo 検証結果と current progress 同期
- 実施内容:
  - `npm run typecheck` / `npm run build` の pass を確認し、plan artefact の validation / status を current state に更新した
  - quality-reviewer の確認結果が重大指摘なしであることを worklog / result / plan に反映した
  - docs-sync 判定として `docs/design/` 更新済み、`.ai_context/` 更新不要、`README.md` 更新不要を記録した
  - manual test gap を `MT-052`〜`MT-056` として明示し、commit / archive 未実施の状態を残した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
  - quality-reviewer: 重大指摘なし
- メモ: 次は manual test `MT-052`〜`MT-056` を実施し、結果反映後に commit / archive 前の最終クローズ確認へ進む
- 関連コミット:

### 0005

- 日時: 2026-03-20
- チェックポイント: same-plan refinement の planning update
- 実施内容:
  - 追加要望を same-plan と判定し、active plan を 3 カラム target に更新した
  - 左 monitor / 中央 `Recent Sessions` / 右 `Characters` の配置判断、monitor panel の最低 acceptance（少なくとも `実行中` / `完了` を分ける）、現行 chip row の統合方針を artefact に反映した
  - `Monitor & Resume` / `Manage Cast` ラベル削除、heading 可読性修正、`Characters` icon-only collapse、collapsed 時の `Add Character` 非表示を refinement task として明示した
  - `result.md` を reopened 状態に合わせて更新し、refinement 実装 / docs sync / validation の再実施が必要であることを記録した
- 検証: 文書更新のみ
- メモ: 次は `src/HomeApp.tsx` / `src/styles.css` / design docs / manual checklist を refinement target に合わせて更新し、実装後に typecheck / build / manual test をやり直す
- 関連コミット:

### 0006

- 日時: 2026-03-20
- チェックポイント: same-plan refinement 実装と再検証
- 実施内容:
  - `src/HomeApp.tsx` を 3 カラム化し、左 `Session Monitor` / 中央 `Recent Sessions` / 右 `Characters` へ再構成した
  - monitor panel を `実行中` と `停止・完了` に分け、`interrupted` / `error` を non-running 側の badge 付き row として残し、旧 chip row は廃止した
  - 左右 panel の collapse を renderer local state で実装し、`Characters` は icon-only toggle + collapsed 中の `Add Character` 非表示へ更新した
  - `src/styles.css` を `.home-page` スコープ中心で調整し、Home 見出しの可読性と sidebar collapse の見た目を補強した
  - `docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / `docs/manual-test-checklist.md` を refinement target に再同期した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
- メモ: manual test は未実施。次は `MT-052`〜`MT-058` と monitor panel 追加観点の実機確認を反映する
- 関連コミット:

### 0007

- 日時: 2026-03-20
- チェックポイント: same-plan follow-up で collapsed rail を icon-only slim sidebar へ調整
- 実施内容:
  - `src/HomeApp.tsx` の collapse toggle を chevron から `≣` 風 glyph へ変更し、left / right の差分は `aria-label` へ寄せた
  - 左右の collapsed rail から縦書き `Monitor` / `Characters` ラベルを外し、toggle button だけ残す構成へ簡素化した
  - `src/styles.css` の Home 専用 CSS で collapsed 幅と toggle 見た目を slim sidebar 寄りに調整し、Session Window への style bleed を避けた
  - `docs/manual-test-checklist.md` の `MT-053`〜`MT-056` を follow-up target に合わせて更新し、`docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / plan artefact を current progress に同期した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
- メモ: manual test は未実施。次は `MT-052`〜`MT-058` と monitor panel 追加観点の実施結果を artefact へ反映する
- 関連コミット:

### 0008

- 日時: 2026-03-20
- チェックポイント: active plan artefact の最終 progress 同期
- 実施内容:
  - `docs/plans/20260320-home-session-monitoring-redesign/plan.md` の task list / completion state を current progress に更新した
  - `docs/plans/20260320-home-session-monitoring-redesign/result.md` の remaining issues / archive check を、manual test と commit / archive だけが未了である状態へ同期した
  - session workspace の `plan.md` を、same-plan refinement 完了・docs sync 完了・repo 検証完了・manual test 未実施という current state に合わせて更新した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
  - quality-reviewer: 重大指摘なし
  - manual test: 未実施（`MT-052`〜`MT-058` と monitor panel 追加観点は checklist 更新のみ完了）
- メモ: 実機 manual test と commit / archive 以外の残件はない状態。次は manual test 実施後に最終クローズ確認を行う
- 関連コミット:

### 0009

- 日時: 2026-03-20
- チェックポイント: same-plan で 2 カラム + open session truth source target へ planning update
- 実施内容:
  - research 結果を `same-plan` として受け、active plan の Goal / Scope / Acceptance / Risks / Validation を 2 カラム target へ更新した
  - `SessionMonitor` の truth source を `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` とし、renderer へは thin IPC / preload bridge を足す方針を `decisions.md` に追記した
  - 右ペインを `SessionMonitor` / `Characters` の排他的切替とし、segmented toggle 採用、初期値 `SessionMonitor`、比率 6:4 目安、左右 collapse を今回 target から外す判断を artefact へ反映した
  - `result.md` を reopened 状態へ更新し、3 カラム / slim collapsed rail 前提 docs と manual test を 2 カラム target へ再同期する必要があることを明記した
  - session workspace `plan.md` を新 target の current task / next steps へ更新した
- 検証: 文書更新のみ
- メモ: 次は `src-electron/main.ts` / `src-electron/preload.ts` / `src/renderer-env.d.ts` / `src/HomeApp.tsx` / `src/styles.css` と design docs / manual checklist を、新 target に沿って same-plan 実装・再検証する
- 関連コミット:

### 0010

- 日時: 2026-03-20
- チェックポイント: 2 カラム + open session truth source の same-plan 実装
- 実施内容:
  - `src-electron/main.ts` に open session window ids の list / broadcast を追加し、`sessionWindows` の open / close / reset / delete に追従して通知するようにした
  - `src-electron/preload.ts` と `src/withmate-window.ts` に thin IPC bridge を追加し、renderer から initial fetch と subscribe の両方を使えるようにした
  - `src/HomeApp.tsx` を 2 カラムへ戻し、右ペイン上部の segmented toggle で `Session Monitor` / `Characters` を排他的に切り替えるようにした
  - `Session Monitor` の source を `filteredSessionEntries ∩ openSessionWindowIds` に差し替え、open な `SessionWindow` がない時の empty state を追加した
  - 既存の collapse / slim collapsed rail UI を Home から外し、`docs/design/desktop-ui.md` / `docs/design/home-ui-brushup.md` / `docs/manual-test-checklist.md` / session workspace `plan.md` を新 target に同期した
  - `src/renderer-env.d.ts` は `WithMateWindowApi` 拡張だけで型追従できたため変更不要と判断した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
- メモ: manual test は未実施。次は `MT-052`〜`MT-058` を中心に実機確認し、結果を artefact へ反映する
- 関連コミット:

### 0011

- 日時: 2026-03-20
- チェックポイント: Home open session購読の same-plan review follow-up
- 実施内容:
  - `src/HomeApp.tsx` の `openSessionWindowIds` 取得 / 購読を mount 中に固定の effect へ分離し、`launchCharacterId` 変更で unsubscribe / resubscribe しない構成へ整理した
  - open session bridge は「先に subscribe を張る → その後 snapshot を取得する」順へ変更し、購読開始後に event を受けた場合は snapshot で上書きしないようにして race による取りこぼし / stale を抑止した
  - character 一覧の初期取得 / 購読で `launchCharacterId` を functional update で整合させる helper に寄せ、購読系 effect が `launchCharacterId` へ依存しないようにした
  - `result.md` / `decisions.md` を review follow-up 内容に合わせて同期した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
- メモ: manual test は未実施。次は `MT-052`〜`MT-058` の実機確認で、Home 表示中に SessionWindow を開閉したとき monitor が取りこぼさず追従するかを重点確認する
- 関連コミット:

### 0012

- 日時: 2026-03-20
- チェックポイント: same-plan で Home right pane micro-refinement を planning update
- 実施内容:
  - research 要約を反映し、追加要件を `same-plan` として active plan へ追記した
  - `src/HomeApp.tsx` の `monitorBaseEmptyMessage` / `monitorRunningEmptyMessage` / `monitorCompletedEmptyMessage` を説明文から簡潔な状態表示へ寄せる方針を `plan.md` に反映した
  - segmented toggle と二重化している pane 内 `Session Monitor` / `Characters` heading を置かない判断を `decisions.md` に追記した
  - `SessionMonitor` の scroll container を session list と同型へ寄せる判断、および manual test の追加観点を artefact と session workspace `plan.md` に同期した
- 検証: 文書更新のみ
- メモ: 次は `src/HomeApp.tsx` / `src/styles.css` / `docs/manual-test-checklist.md` を current reopen target に沿って更新し、その後 manual test へ進む
- 関連コミット:

### 0013

- 日時: 2026-03-20
- チェックポイント: same-plan reopen の right pane micro-refinement 実装
- 実施内容:
  - `src/HomeApp.tsx` で `SessionMonitor` の empty state を短い状態表示へ寄せ、pane 内 `Session Monitor` / `Characters` heading を削除した
  - `Characters` 側の `Add Character` は heading を置かず、search row に残す構成へ移した
  - `src/styles.css` を `.home-page` スコープで調整し、monitor body を right pane 内の安定した縦スクロール container に寄せた
  - `docs/manual-test-checklist.md` / active plan artefact / session workspace `plan.md` を current reopen progress に同期した
- 検証: 未実施（この時点では manual test 未実施）
- メモ: 次は `npm run typecheck` / `npm run build` を再確認し、その後 `MT-052`〜`MT-058` を中心に manual test 実施結果を artefact へ反映する
- 関連コミット:

### 0014

- 日時: 2026-03-20
- チェックポイント: same-plan reopen 実装後の repo 検証
- 実施内容:
  - current reopen の Home right pane micro-refinement 反映後に `npm run typecheck` / `npm run build` を再実行した
  - manual test 未実施のため、remaining は `MT-052`〜`MT-058` 実施と artefact 反映のみであることを確認した
- 検証:
  - `npm run typecheck`: pass
  - `npm run build`: pass
- メモ: 次は `MT-052`〜`MT-058` を中心に manual test を実施し、結果を `result.md` へ反映する
- 関連コミット:

## Open Items

- `MT-052`〜`MT-058` を中心に manual test を実施し、結果を artefact へ反映する
- commit / archive 前確認は user 指示に従って未実施のまま status を維持する
