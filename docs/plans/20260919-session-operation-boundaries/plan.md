# Session 操作の排他・取消・永続化の分離

## 対象と基準

- Issue: https://github.com/natumekazuki/WithMate/issues/726
- 開始 commit: `04ac31a5c92b8c52ce104574e7ff2054df89fddb`
- 対象: `fix/issue-726`、V6 runtime。既存ユーザーデータを維持する。
- Issue は横断変更であり、以下を独立して安全な単位に分ける。部分変更だけで Issue 完了とはしない。

## 現行経路の棚卸し

| 操作 | 現行 owner / 長時間処理 | 変更すべき境界 |
| --- | --- | --- |
| Affect settlement | `main.ts` の drain が ownership coordinator 内で外部評価を待つ | 評価と、owner 再検証・version 付き適用を分離 |
| Auxiliary 作成 | Provider coordinator → ownership coordinator → 親取得・設定解決・保存 | 受付・準備・取消・親生存再検証・commit・結果照合 |
| Main 作成 | Provider coordinator 内で設定解決・SessionFolder 作成、保存後 default Auxiliary 初期化 | 準備の分離、generation / 設定再検証、部分成功の定義 |
| Character authoring | Provider coordinator 内で directory / skill 準備 | filesystem 準備の分離と当該試行のみの cleanup |
| 通常更新・terminal | Session mutation queue と UPSERT | create と既存行限定 update を分離、確定時の存在確認 |
| 削除・期間削除 | ownership coordinator 内で削除と provider thread 無効化 | 親子 admission / 削除 commit と外部後処理を分離 |
| Settings / catalog | Provider coordinator、全 Session / Auxiliary snapshot の保存・rollback | 対象 field / row の短い更新、利用中判定と admission の整合 |
| V6 storage | lifecycle が Session / Audit / Auxiliary / Character / Settings / Catalog / Mate を Main 上で生成 | 限定 command API を持つ storage Worker |
| Memory / Affect | `memory-v6-runtime.ts` の HTTP server も Main 上。Main から context service の直接呼出しもある | DB execution owner を Worker へ移動。認可と CLI の HTTP 契約を維持 |
| Affect settlement storage | `main.ts` から直接同期 SQLite 接続 | 同じ Worker / generation の lifecycle へ統合 |
| Memory review | `memory-v6-review-service.ts` が要求ごとに直接 DB 接続 | Main の同期接続の抜け道を閉じる |
| 起動・maintenance | database path/bootstrap、schema、WAL、診断、Auxiliary read 内 backfill | 明示的な Worker command と中断・再開契約 |

Companion の create IPC 配線と `requireCompanionStorage()` は存在する。V6 での実利用可否は、UI の admission と storage schema を含め追加確認が必要であり、現時点で未使用とは断定しない。legacy を復活させない。

## 実装単位と完了条件

1. Affect 評価の待機分離、Session の既存行限定保存。
   - LLM 評価中に無関係な Session 操作が進むことを deferred で確認する。
   - 適用時の owner / committed assistant turn / 共有 Affect version と既存 retry / idempotency を維持する。
   - 単体・期間削除後に古い update / terminal を再開しても DB、cache、provider binding を復活させない。
2. 作成準備・Settings / catalog・親子 admission の限定操作化。
   - 外部 I/O 中の広域ロックを解消し、commit 時に権限・設定・generation・対象生存を検証する。
   - 全 snapshot rollback による無関係な更新・削除の巻き戻しを廃止する。
3. V6 storage Worker と caller 非同期化。
   - 同期 SQL、重い変換、backfill を Main に残さない。
   - Worker exit、close/reset/reopen、旧 generation、commit 結果不明を明示し、無差別 retry しない。
   - SQL busy 中の Main timer / IPC 継続、build 後の Worker 起動、既存データコピーによる維持を検証する。
4. Auxiliary 作成要求の lifecycle と UI。
   - 認証済み Window / 親 Session と request identity を結び付ける。
   - queued / preparing の取消と commit の先後、重複・先着取消・遅い応答・再接続を検証する。
   - 待機中も既存 Session へ戻れる。既存 launch shell、focus、Escape、結果照合を維持する。
5. 診断・ADR・最終検証。
   - queue / DB / Main event-loop / renderer projection を区別できる最小診断を整える。
   - ADR 007 の Provider 選択・権限・generation の目的を維持し、方式変更を記録する。
   - 型検査、関連 service / IPC / component / DB test、build、分離 Electron 確認を行う。

## 検証と操作の制約

- 任意 sleep の速さではなく barrier と実 service / 一時 DB の観測を優先する。
- 変更 test は開始 commit から `review-test-value` で抽出し、通常の read-only `general_luna` review を行う。
- UI 変更時は `design-ui-information` と製品規約に従う。Computer Use は明示指示なしで実行しない。
- Electron の分離起動は `scripts/start-withmate-visual-check.ps1` を候補として提案する。検証用 process の差替えを明示し、インストール版を停止しない。
- Issue の実機停止時の lock 保持者や SQLITE_BUSY は未確定。コードで確認した待機連鎖と区別する。

## 進捗

- 棚卸し: 上表の経路を確認。Companion 実利用可否と全 caller の移行対象確定は未完了。
- 実装単位 1: 実装済み。Affect の評価は ownership 外、owner 再検証・appraise・settlement 確定は同じ境界に配置。V6 runtime の通常保存と terminal 保存を既存行限定 API へ配線した。全体の排他方式はまだ置換していない。
- 実装単位 2〜5: 未完了。

### 実装単位 1 の検証

- Session storage / persistence / command facade / update-only の関連 70 tests が成功。
- Affect settler / generation / drain / ownership / settlement storage / recovery、CLI-MCP、Auxiliary storage の関連 55 tests が成功。レビュー指摘への test 補強後は影響する test を再実行した。
- `npm run typecheck`、`npm run build` が成功。最終 Main 修正後の `npm run build:electron` も成功。renderer build には既存の大きな chunk に関する warning がある。
- 変更 test は開始 commit から決定論的に抽出。7 records、抽出 diagnostic は 0 件。通常の read-only `general_luna` に Affect 4 件・CRUD 3 件を分けて review し、terminal 保存の read-back / rollback、owner discard の直接観測、fixture、metadata の観測範囲を修正した。
- schema 変更、データ migration、UI 変更は行っていない。通常の `upsertSession` は既存の fixture / 一括置換用 API として残すが、V6 Main の通常更新・terminal 保存は使用しない。

### 未確認・残作業

- 上記は実 service と一時 DB を接続した検証であり、Electron Main 全体を起動した E2E ではない。Main の drain / storage 配線は diff で確認し、配線の取り違え自体を検出する E2E は未実施。
- generation test は実 SQLite 接続の交換と settler の await 境界を検証する。Main の Memory runtime 交換、failure 記録、中断回収の実配線は直接試験していない。
- 同一 Character の複数 Session の並行評価、Settings rollback、親削除と Auxiliary Turn admission、Main cache と非同期 Worker 応答の先後は最終受入試験が必要。
- storage Worker、全 caller 非同期化、backfill maintenance、Worker fault / generation / 結果不明、request 取消・重複抑止・再接続、UI、queue / DB / event-loop 診断は未実装。
- Electron の分離環境、GUI、配布物、既存ユーザーデータコピーによる migration 確認は未実施。分離起動する場合は `scripts/start-withmate-visual-check.ps1` を使い、検証用 process の差替えを事前に明示する。
- Issue #726 と関連 Issue を close しない。第一段階の commit を Issue 全体の完了と解釈しない。
