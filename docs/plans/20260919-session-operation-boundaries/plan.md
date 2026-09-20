# Session 操作の排他・取消・永続化の分離

## 対象と基準

- Issue: https://github.com/natumekazuki/WithMate/issues/726
- 開始 commit: `04ac31a5c92b8c52ce104574e7ff2054df89fddb`
- 対象: `fix/issue-726`、V6 runtime。既存ユーザーデータを維持する。
- Issue は横断変更であり、以下を独立して安全な単位に分ける。部分変更だけで Issue 完了とはしない。

## 変更前の経路の棚卸し

| 操作 | 現行 owner / 長時間処理 | 変更すべき境界 |
| --- | --- | --- |
| Affect settlement | `main.ts` の drain が ownership coordinator 内で外部評価を待つ | 評価と、owner 再検証・version 付き適用を分離 |
| Auxiliary 作成 | Provider coordinator → ownership coordinator → 親取得・設定解決・保存 | 受付・準備・取消・親生存再検証・commit・結果照合 |
| Main 作成 | Provider coordinator 内で設定解決・SessionFolder 作成、保存後 default Auxiliary 初期化 | 準備の分離、generation / 設定再検証、部分成功の定義 |
| Character authoring | Skill 読込み・生成内容の準備は coordinator 外。managed files 反映と保存は coordinator 内 | 書込み待機の分離と共有 managed files の反映境界は残作業 |
| 通常更新・terminal | Session mutation queue と UPSERT | create と既存行限定 update を分離、確定時の存在確認 |
| 削除・期間削除 | ownership coordinator 内で削除と provider thread 無効化 | 親子 admission / 削除 commit と外部後処理を分離 |
| Settings / catalog | Provider coordinator、全 Session / Auxiliary snapshot の保存・rollback | 対象 field / row の短い更新、利用中判定と admission の整合 |
| V6 storage | lifecycle が Session / Audit / Auxiliary / Character / Settings / Catalog / Mate を Main 上で生成 | 限定 command API を持つ storage Worker |
| Memory / Affect | `memory-v6-runtime.ts` の HTTP server も Main 上。Main から context service の直接呼出しもある | DB execution owner を Worker へ移動。認可と CLI の HTTP 契約を維持 |
| Affect settlement storage | `main.ts` から直接同期 SQLite 接続 | 同じ Worker / generation の lifecycle へ統合 |
| Memory review | `memory-v6-review-service.ts` が要求ごとに直接 DB 接続 | Main の同期接続の抜け道を閉じる |
| 起動・maintenance | database path/bootstrap、schema、WAL、診断、Auxiliary read 内 backfill | 明示的な Worker command と中断・再開契約 |


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

- 棚卸し: V6/Main/Auxiliary/Memory/Affect の caller を非同期 storage boundary へ移行した。Main の同期 SQLite 接続を runtime guard と静的 check で禁止する。
- 実装単位 1: 完了。Affect の評価は ownership 外、owner 再検証・appraise・settlement 確定は同じ境界に配置。通常保存と terminal 保存は incarnation を照合する既存行限定 API を使用する。
- 実装単位 2: 完了。削除の外部後処理、作成の準備、Character authoring のファイル反映を広域排他から分離した。Character 単位の反映と maintenance drain、親子 Turn admission、Settings の provider admission と限定 field / CAS rollback を組み合わせる。
- 実装単位 3: 完了。Session / Settings / Catalog / Auxiliary / Character / Mate / Affect settlement と bootstrap / maintenance の Worker 経路、および Memory / Affect の Worker 経路を接続した。typed command whitelist、fault、shutdown drain、generation、結果不明、domain error の transport を検証した。summary backfill は明示的・bounded・再開可能な command とする。
- 実装単位 4: 完了。authenticated IPC と request identity により、準備・待機・取消・commit・結果照合を管理する。cancel-first、dedupe、親・storage 再検証、再open、遅い応答、unknown の再照会を検証した。待機中の復帰と既存 launch shell の focus / Escape を維持する。
- 実装単位 5: 完了。診断・ADR / design 更新、分離 Electron / UI fixture、変更 test の審査と全体検証を実施した。検証範囲と未確認事項は末尾に記録する。

### 第一段階レビューへの対応と削除後処理

- レビュー対応開始 commit: `28e7b4d1ad62b00e2c3f69b9ef2334f5b5cfa197`。今回の変更 test はこの base から抽出する。
- CLI/MCP integration test の metadata を実際の検証範囲へ修正。Affect 投影に加え、未知 family の拒否、Character Memory の追加・訂正・検索・忘却、storage 障害の error mapping を明記し、既存 assertion は維持する。
- Main の通常更新・terminal 保存を共通の storage command adapter へ移し、実 V6 DB と SessionPersistenceService から同じ adapter を使用する。成功時の cache / broadcast、削除競合と terminal marker mismatch 時の非更新を検証する。
- Affect の settle / drain orchestration を `character-affect-turn-main-lifecycle.ts` へ移し、Main が同じ実装を使用する。runtime だけの交換と storage の close / reopen、それぞれ評価成功・評価例外の 4 経路で、旧 storage への遅延 write がないこと、current pending が次回 drain で完了することを確認した。storage 交換時には、旧 drain が交換後 cursor を上書きしないことも確認した。
- 削除 commit、cache 除去、親子 binding 失効、window / broadcast 投影を ownership 内で行い、provider thread 後処理は解放後に待つ。後処理失敗時も残りの対象を試み、削除済みであることを示す AggregateError を返す。
- Settings / catalog は依然全 snapshot 置換である。単なるロックの移動では不十分で、対象 runtime field の限定更新、競合条件、rollback、Turn admission を一緒に扱う必要がある。
- 今回の関連検証は Session / Affect / CLI-MCP / Auxiliary storage の 128 tests が成功。`npm run typecheck`、`npm run build` が成功し、build の warning は既存の renderer chunk サイズ警告。
- 変更 test は今回 base から 7 records を抽出し、diagnostic は 0 件。通常の read-only `general_luna` review で oracle の実在参照、metadata の観測範囲、後処理順序への過結合を修正した。Main / IPC / GUI の E2E や Issue 全体の完了を意味しない。

### 実装単位 1 の検証

- Session storage / persistence / command facade / update-only の関連 70 tests が成功。
- Affect settler / generation / drain / ownership / settlement storage / recovery、CLI-MCP、Auxiliary storage の関連 55 tests が成功。レビュー指摘への test 補強後は影響する test を再実行した。
- `npm run typecheck`、`npm run build` が成功。最終 Main 修正後の `npm run build:electron` も成功。renderer build には既存の大きな chunk に関する warning がある。
- 変更 test は開始 commit から決定論的に抽出。7 records、抽出 diagnostic は 0 件。通常の read-only `general_luna` に Affect 4 件・CRUD 3 件を分けて review し、terminal 保存の read-back / rollback、owner discard の直接観測、fixture、metadata の観測範囲を修正した。
- schema 変更、データ migration、UI 変更は行っていない。通常の `upsertSession` は既存の fixture / 一括置換用 API として残すが、V6 Main の通常更新・terminal 保存は使用しない。

### 再レビューへの対応（1032e6bf 起点）

- Session に行単位の incarnation を追加した。既存 V6 行は `legacy:<id>`、新規行は UUID とし、通常更新・terminal 保存・incremental running 保存で対象行と一致することを transaction 内で確認する。同じ ID の再作成へ古い本文や marker を適用しない。
- Affect pending に Session incarnation を保存し、drain 受付と評価適用で照合する。旧 pending と既存 correlation fingerprint の互換性を保ち、既存列構成からの migration を一時 DB で検証する。
- unready / ready の Session 読取 await 後にも storage identity を検証し、交換前の storage に ready / discard を書かない。close / recreate は drain cursor を破棄する。
- 削除後処理は ownership 内で全対象の旧 provider runtime 参照を切り離し、外部切断だけを解放後に待つ。同一 ID の新 runtime は古い後処理の対象にしない。
- cache で削除済みと分かった通常更新も `SessionNotFoundError` を返す。
- 検証: 全体 `npm test` は 2,883 pass / 0 fail / 1 skip。審査後に補強した drain / update-only の 12 tests も成功。`npm run typecheck`、`npm run build`、Settings 変更後の `npm run build:electron` が成功。renderer の既存 chunk サイズ warning は残る。
- 変更 test はこの起点から 22 records / 22 transitions を抽出し、diagnostics は 0 件。通常の read-only `general_luna` で全件を審査し、generation test を実 storage close / reopen と次回 drain 完了へ補強、metadata の観測範囲と terminal marker 不変確認を修正した。新規 incarnation migration は一時 DB であり、実ユーザーデータや Electron Main / IPC E2E の確認ではない。
- 再レビュー修正 commit: `c041c1d5`。

### 続きの Settings rollback 境界

- Settings 更新では Session / Auxiliary の thread reset 書込みを試みたかを個別に記録し、試みていない collection は rollback で全体置換しない。設定だけの保存後の失敗で並行削除・更新を復元前値へ戻さない。
- controlled deps の deferred を使い、設定保存待ち中の Session 削除と Auxiliary 本文更新を再現した。projection 失敗の伝播、設定の rollback、並行 collection 変更の保持を検証。関連 Settings 14 tests が成功し、変更 test 1件を上記 22 records に含めて審査した。
- 実際に thread を変更した場合の限定 field 更新と catalog migration の全 snapshot 廃止は引き続き未完了。Worker 化や Turn admission の完了を意味しない。

### 第三回レビューの要確認対応（ffa38606 起点）

- 確定指摘は 0 件。Q1 は runtime 交換時の未保存評価と durable evaluation を文書が区別していなかったため、ADR 020 の既存 idempotency 契約に合わせて明確化した。未保存結果は破棄し、保存済み candidate / expected version / key は同一のまま再照合する。新しい評価や key を runtime 交換だけで発行しない。
- Main で確認した Memory runtime の lifecycle は起動時 start と終了時 stop であり、通常操作による runtime-only restart の到達を確認したとは扱わない。component test で保存後の ownership 待ち・appraise 応答待ちを明示的に中断し、次回 drain まで検証した。
- 続きは Main SessionFolder の外部準備を provider coordinator 外へ分離した。commit 前に現行 storage identity と launch selection を再検証し、準備途中の変更を別の権限や provider へ救済しない。再検証失敗時は今回の folder のみを cleanup し、保存呼出し開始後の結果不明エラーでは folder を保持する。directory workspace、Character authoring、Auxiliary の外部準備はこの単位には含めない。
- 検証: Affect / Main 作成 / Settings / launch selection / SessionFolder の関連 81 tests、`npm run typecheck`、`npm run build` が成功。保存中の Settings 待機 assertion 補強後も Main 作成の 24 tests が成功。renderer の既存 chunk サイズ warning は残る。全体 `npm test`、Electron E2E、実ユーザーデータコピーの検証は今回未実施。
- 変更 test は今回の起点から 5 records / 5 transitions を抽出し、diagnostics は 0 件。通常の read-only `general_luna` で全件を審査した。保存中の Settings 更新待機を直接観測する assertion を補強し、最新差分で追加指摘なし。保存済み評価の再利用と起動設定・storage 再検証は継続する契約であり、恒久保持する。

### 第四回レビューと続き（39808ada 起点）

- 確定指摘は 0 件。U1 の実行検証を固定 HEAD `39808adad2aa118615f69cf20545fef04598832a`、変更なしの状態で実施した。全体 `npm test` は 2,885 pass / 0 fail / 1 skip。`npm run typecheck` と `npm run build` が成功した。テスト出力には React / jsdom の `attachEvent` 例外ログがあるが、runner の failure は 0 件。renderer の chunk サイズ warning は継続している。
- U2 の実ユーザーデータコピー、Electron Main / IPC、実 Provider、実 Memory runtime lifecycle、実画面は未確認のままとする。上記のテスト成功で代替確認済みとはしない。
- Auxiliary 作成の準備と commit を分離した。準備中の親削除・再作成、storage 交換、設定変更を commit 前に再検証する。親 Character の変更と選択済み Character の削除・archive も拒否し、commit 時の親の Speed / Reviewer / directory 設定を保存する。既存 requestId の再送にも入力検証を先行させ、並行再送は同じ保存行を返す。
- 変更後は関連 49 tests と新規の競合境界 3 tests、`npm run typecheck`、`npm run build:electron` が成功。新規境界 test は実 coordinator・実 Auxiliary SQLite storage と制御した親を使い、初回と commit 側の親読取待ちで旧 storage を close して交換する。V6 親行の migration や Electron E2E の検証ではない。
- 今回の起点から変更 test を 6 records / 6 transitions として抽出し、diagnostics は 0 件。通常の read-only `general_luna` が全件を審査した。親読取の第二 barrier、独立した identity 変更、保存直前の Character 失効を直接観測するよう補強し、既存成功 test の metadata を実際の保存値の観測範囲へ修正した。再送の入力検証優先を文書化し、最終審査で追加指摘なし。既存契約の並行実行時の破壊を検出する恒久 test として保持する。
- Worker 化、同期 Character ファイル読取の解消、作成取消、Turn admission はこの単位の対象外。

### 第五回レビューと続き（45db6cdc 起点）

- 確定指摘は 0 件。レビュー側では非生成型検査と静的確認が実施され、U1 の実行 test / build は未実施だった。直前の実装作業では同じ変更内容に対する関連 52 tests、型検査、Electron build が成功している。これはレビュー側の実行証拠とは区別する。
- U2 の実環境統合・コピー DB migration は未確認のまま維持する。実行済みの component test を Electron / Provider / 実データ受入の代替とはしない。
- Settings credential 変更時の thread reset と rollback を限定 field 更新へ移行した。Main の incarnation / provider / 元 thread、Auxiliary の親 / 作成時刻 / provider / 元 thread を storage transaction 内で照合する。本文・draft・並行削除を snapshot で戻さず、Main cache も現行行の対象 field だけ投影する。確実に更新できた対象だけ reverse CAS し、書込み結果不明の例外へ無条件の逆書込みをしない。thread が空の対象も provider runtime invalidation は維持する。
- 検証: 全体 `npm test` は 2,893 pass / 0 fail / 1 skip。`npm run typecheck`、`npm run build` が成功。空 thread の invalidation assertion 補強後も Settings の 16 tests が成功。renderer の既存 chunk サイズ warning は残る。今回の起点そのものの全体実行ではなく、上記変更を含む working tree の実行結果である。
- 変更 test は今回の起点から 9 records / 9 transitions を抽出し、diagnostics は 0 件。通常の read-only `general_luna` が全件を審査し、storage / cache の現行内容保持、service の rollback 対象選択、空 thread の runtime invalidation を直接観測するよう補強した。oracle を実在する設計書と ADR へ揃え、最終審査は追加指摘なし。Main 配線と Auxiliary の実 storage 経路も別途 read-only で確認した。
- catalog import/reset の全 snapshot 更新、provider 後処理待機、Turn admission、Worker 化は別の残作業とする。

### 第六回レビューと続き（c43cdf3d 起点）

- 確定指摘は 0 件。Q1 の同期通知例外が provider 後処理を省く経路へ対応した。削除 commit 後の個々の投影失敗を保持し、残りの親子投影と全 provider detach を ownership 内で試みる。ownership 外で後処理を待ち、通知と provider の失敗を合わせて AggregateError で返す。DB 削除を巻き戻さない。
- 単体・期間削除それぞれで close / broadcast の同期例外と provider 後処理失敗を組み合わせ、別 Session 削除の進行、後処理完了前の未応答、親子 detach、同一 ID 再作成後の DB / cache / runtime 保持を検証した。これは依存への例外注入であり、実 Electron の window 破棄競合を再現した証拠ではない。本番で同じ同期例外になる条件は未確認。
- 検証: 関連 55 tests（削除後処理の 1 test 内に 12 組合せ）、`npm run typecheck`、`npm run build:electron` が成功。今回の変更に対する全体 `npm test` と renderer build は未実施。U2 の実環境統合・コピー DB migration は引き続き未確認。
- `review-test-value` で今回起点から 1 record / 1 transition を抽出し、diagnostics は 0 件。通常の read-only `general_luna` が全件を審査し、追加指摘なし。削除済み runtime の失効と非同期後処理のエラー伝播は型検査だけでは担保できず、実 DB を使う約 0.4 秒の test として保持する。
- 続きとして Character authoring の作成経路を確認した。既存 Character directory に Skill と managed files を上書きするため、`prepareWorkspace` をそのまま排他外へ移すと、競合した試行が共有ファイルを破壊し得る。次の実装では試行専用の準備領域と managed files 反映の境界、Character / provider / storage の再検証が必要である。Character directory 全体の削除による cleanup は採用しない。現時点では調査までで、この準備分離は未実装。

### 第七回レビューと続き（a81bd9c1 起点）

- レビューの確定指摘は 0 件。U1 はレビュー時の実行 test / build 未実施、U2 は実環境統合・コピー DB migration の未確認であり、既存の実装時検証とは区別する。
- Character authoring の準備を段階的に分離した。今回は同梱 Skill の非同期読込みと生成内容をメモリに保持し、共有 workspace に触れる前に provider coordinator 外の準備を完了させる。前回調査で挙げた disk staging は導入しない。既存 directory の上書きを排他外へ移さず、準備領域の cleanup や復元機構を追加しない変更とした。
- 最終反映の前に storage identity、provider、Character、workspace directory を再検証する。managed files 反映と Session 保存は引き続き coordinator 内で行う。書込み I/O 待機の排他外への分離、filesystem transaction、Character 更新・削除との完全な admission 統合は未完了。
- 検証: Character authoring の 18 tests、全体 `npm test`（2,898 pass / 0 fail / 1 skip）、`npm run typecheck`、`npm run build` が成功。renderer の既存 chunk サイズ warning は継続。固定起点そのものではなく、今回変更を含む working tree の結果である。実 Electron、実 Provider、実ユーザー DB コピーは未確認。
- `review-test-value` で今回起点から 7 records / 7 transitions を抽出し、diagnostics は 0 件。通常の read-only `general_luna` が全件を審査し、追加指摘なし。既存 test の正規表現内の backtick 1 文字は、抽出器の字句誤認を避けるため同義の `\x60` に変更した。assertion の契約は変えていない。実 coordinator と一時 filesystem、制御した provider / Character / storage identity を使う component test として保持する。実 DB 更新や Electron E2E の競合再現とは扱わない。

### catalog import rollback の対象限定（4d24f808 起点）

- Main / Auxiliary の置換試行を個別に記録し、失敗時に未試行 collection を復元しない。試行済み collection の全 snapshot 復元は維持し、限定 field 更新や結果不明の解消まで完了したとは扱わない。
- controlled deps の保存待ちで未試行 collection の並行更新・削除を再現する。書込み後の失敗と rollback 失敗も組み合わせ、保存内容と元の例外・AggregateError を検証する。実 DB / Electron の競合再現ではない。
- 検証: Settings の 17 tests（追加 test は失敗位置と rollback 成否の 6 組合せ）、`npm run typecheck`、`npm run build:electron` が成功。今回の変更で全体 test、renderer build、実 Electron / 実 DB の競合検証は実施していない。
- `review-test-value` で今回起点から 1 record / 1 transition を抽出し、diagnostics は 0 件。通常の read-only `general_luna` が最新版を審査し、追加修正要求なし。catalog の入力と復元値を区別する assertion を補強した。未試行 collection のデータ保護は継続する契約で、型検査では代替できず、約 1 ms の component test として保持する。

### 最終実装・検証の現状（cef633b8）

- 最終 `npm test` は 2,952 tests、2,951 pass / 0 fail / 1 skip。Worker shutdown、domain error、Character ファイル検証、Auxiliary hook と審査後の assertion 補強を含む working tree の結果である。
- 全体実行後は test metadata の参照修正と resource lane test の失敗時 cleanup のみ変更し、影響する Worker 13 tests を再実行して成功した。production code は変更していない。
- `npm run typecheck`、`scripts/check-sqlite-owner-boundary.ts`、`npm run build` は成功。renderer build には既存の 500 KB 超 chunk warning が残る。
- コンパイル済み Electron の分離 fixture で `app.whenReady`、storage Worker の起動・終了・再open を確認し、exit code 0 だった。seeded representative V6 DB のコピーでは、Main / Auxiliary の非空 messages、Character definition / snapshot、Settings、Memory、Affect が reopen 後も保持された。V6.3.29-preview.1 の schema から `incarnation_id` を seed せず、初期化時に `legacy:worker-session` へ移行されることを実際に確認した。
- SQL busy の write wait 中も Main の 1 ms timer が 357 回進行した（合計 451 回）。write は想定どおり失敗したが、Main event loop が storage wait で停止しないことを確認した。
- Character の非同期準備は SQL 待機前に実行し、Character / Mate の file I/O は DB queue 外の per-store lane で実行する。shutdown 時は各 lane を drain する。
- UI は offscreen Electron の PNG で待機中・結果不明時の dialog の実描画を確認し、production hook を通した jsdom / dialog flow（Escape から focus 復帰、再open、cancel、commit wins、unknown の再照会 recovery）を確認した。full Main GUI、実 Provider、インストーラは未確認である。
- 代表 V6 DB は検証用コピーのみを使用した。実ユーザー DB の読み取り、外部 Provider、インストール済みアプリ、配布物の受入は実施していない。

### 最終審査と未確認事項

- 最終 diff を再開時の `6c7acfe351fd9b1766aa11f759cfa1d2f076a08c` から `review-test-value` で抽出した。135 records / 135 transitions、diagnostics 0、metadata 欠落 0。通常の read-only `general_luna` に 6 組へ分けて全件を審査し、fixture の観測漏れ、非同期経路、失敗時 cleanup、oracle と主張の精度を修正した。最終確認で追加の修正要求はない。
- ローカル実装、型検査、全体 test、build、compiled Electron の代表データ継続性確認まで完了した。実ユーザー DB、full Main GUI と実 Provider の結合、インストーラによる配布物受入は未確認であり、fixture 成功で代替しない。
- push、タグ付与、リリース公開、Issue #726 と関連 Issue の close は行わない。今回の実装 commit はリリースではない。

### レビュー指摘対応（cef633b8 起点）

- Settings の deferred rollback は storage owner と reset 境界を照合し、設定値が同値でも初期化後へ旧 credential を戻さない。同一 provider の cleanup 重複は未完了数で管理し、復元成功時は Settings / catalog と Session invalidation を再配信する。
- Auxiliary の credential 変更は親と異なる provider の実行・admission 予約も拒否対象とする。更新・復元通知は子 ID ではなく親 Session ID に送り、重複を除去する。Auxiliary の条件付き保存は Worker transport でも mutation として扱い、切断時に書込み結果不明を伝播する。
- Character Memory の episode 追加では非同期 Session scope 検証を待ち、不在・削除済み・別 Character の Session を保存前に拒否する。
- Auxiliary の通常更新・runtime 保存・終了・復旧は、捕捉した storage と既存 payload の CAS を使う。親が削除された行の再挿入と、分精度の更新時刻が同じ並行 payload の上書きを防ぐ。V6 の親確認を残存 legacy Session 行で代替しない。
- Turn admission は短い排他で starting を予約し、Worker 読込みを排他外で待ち、最終的に owner / maintenance / cancel / provider を再検証する。Auxiliary の終了も開始予約と直列化する。削除先行・読込み失敗・取消・reset・provider 拒否・待機中の別操作を実 service と coordinator の barrier で確認した。
- ADR 007 / 010、Character authoring、Session persistence / lifecycle の現行説明を実装へ合わせた。過去段階の snapshot rollback や Main 起動時の error 復旧を現行仕様として扱わない。
- 最終変更を含む全体 `npm test`: 2,962 tests、2,961 pass / 0 fail / 1 skip。Settings / Worker の関連 36 tests も成功。Auxiliary の親 Reviewer / Approval 保持は V6 storage の再読込みで確認した。`npm run typecheck` と SQLite owner check は成功。renderer build は成功、Electron build は初回の CAS null guard 型エラーを修正し、最終の guard / 通知修正後も再実行して成功。既存の renderer chunk サイズ warning は残る。
- `review-test-value` で今回起点から 15 records / 15 transitions を抽出し、diagnostics / warnings / metadata 欠落は 0 件。通常の read-only `general_luna` が全件を審査し、最終差分で全件 PASS。親状態の実 DB 再読込み、rollback 後の新 revision、Auxiliary の親通知、Worker proxy の mutation 分類を観測するよう補強した。
- 実装差分も別の read-only 審査を実施した。mutation 分類・通知対象・Auxiliary の credential guard の指摘を反映し、最終静的確認で追加の高確度不具合は見つからなかった。審査担当は tests / build / ファイル生成を実行していない。
- 今回は実 Electron GUI / 実 Provider / 実ユーザー DB / インストーラを検証していない。SQLite fixture、制御した非同期依存先、runtime/coordinator test を実環境の競合再現と同一視しない。

### 追加レビュー対応（0bbb6388 起点）

- Session の開始予約後の admission 待機を既存の cancel grace へ接続する。要求への応答後も元処理終了までは terminating guard を維持し、provider 開始と同一 Session への再送を防ぐ。Affect readiness の detached retry は persistent store owner の失効時に `absent` で終了し、現 owner の一時障害だけ再試行する。
- Auxiliary の保存前検証失敗は確定した失敗、保存 dispatch 後の不明結果は `unknown` として区別する。遅延取消では同じ要求の保存結果を優先し、cancel 先着時の保存抑止を維持する。
- 取消側の永続化 lookup 前に要求を予約し、並行 create の割込みを抑止する。lookup 待機中に照会側で確定した状態を古い成功・失敗結果で上書きしない。確定結果は必要な Session ID を同期的に保持し、詳細 hydrate を結果確定の条件にしない。保存済みと確定した取消予約は除去し、同じ request ID の再送は既存行へ収束させる。取消だけの lookup 失敗は再照会で収束し、owner 失効後は `expired` とする。
- renderer は `committed` の詳細回復中も開始操作を無効にし、適用後に解除する。`design-ui-information` に従い既存 Session の theme / launch dialog / native disabled を再利用し、画面構造と文言は変更しない。実 hook と dialog の操作 test、および分離した Electron fixture の 1024×768 描画で詳細待機中と適用後の disabled / enabled を確認した。実 Main IPC、実データ、実 Provider を使った操作の証拠ではない。
- 通知設定の並行取得は両 Promise の拒否を取得開始時から処理する。通知可否の失敗は通知抑止、preview のみの失敗は既存の固定文へ戻し、process の未処理 rejection へ漏らさない。F5/F6 は修正前に失敗を確認し、修正後の関連 29 tests が成功した。
- 全体 `npm test` は 2,967 tests、2,966 pass / 0 fail / 1 skip。全体実行後の Auxiliary 確定競合の補強については関連 224 tests、`npm run typecheck`（SQLite owner check を含む）、`npm run build:electron` が成功した。`npm run build` も成功し、renderer の既存 chunk サイズ warning は残る。renderer は全体 build 後に変更していない。
- `review-test-value` で今回起点から 7 records / 7 transitions を抽出し、diagnostics は 0 件。通常の read-only `general_luna` が全件を確認し、metadata の観測境界と遅延取消 test の未使用 fixture を整理した。最終差分で追加の修正要求・context 不足はない。公開結果・再送抑止・通知失敗・操作可否の現在契約を確認する test であり、型や build では代替できず、小さい SQLite / 制御 Promise / jsdom の実行・保守負担に対して保持価値がある。fixture 整理後の対象 12 tests も成功した。
- 実装差分も別の read-only 審査を実施した。取消と照会の並行確定、ID の同期保持、確定した取消予約の除去を補強し、最終確認で追加の高確度不具合は確認されなかった。最後の再送ケース補強後も関連 224 tests、型検査、Electron build が成功した。
- 実 Main GUI / 実 Provider / 実ユーザー DB / Windows 通知の実表示 / インストーラは未確認。SQLite fixture、制御した非同期依存先、offscreen 描画を実運用の結合確認と同一視しない。push、タグ付与、リリース公開、Issue close は実施しない。
