# Electron Session Store

Session、Auxiliary、監査、設定、catalogの永続化はMainが公開するserviceとstorage Workerのtyped commandで扱う。SQLiteの実行owner、schema、tableは[Database Schema](database-schema.md)を参照する。Rendererは`window.withmate`のpreload APIを通し、DBへ直接接続しない。

## 読取と通知

Homeは`listSessionSummaryPage()`でrecent、pinned、open Sessionと検索結果をboundedに取得する。全Session本文をHomeへ送らない。Session Windowは対象Sessionを`getSession()`でhydrateし、変更通知を受けた対象を再取得する。summaryのinvalidationは`WindowBroadcastService`が`ids`または`all`として配信し、IDが上限を超えた場合は切り捨てず`all`へ切り替える。Homeは古いquery responseをgenerationで失効させ、既に取得したpageを必要範囲で再同期する。

## 書込みとowner

### SessionPersistenceService

`SessionPersistenceService`が作成、既存行更新、削除、期間削除を担当する。owner付きstorage command、cache projection、Window side effectの組み立ては`src-electron/session/session-persistence-assembly.ts`が担う。実行中のturnとcancelは`SessionRuntimeService`、Windowのclose／quitは`SessionWindowBridge`とlifecycle側で扱う。作成と既存行限定更新を分け、削除済み行を遅延更新で再作成しない。

### SettingsCatalogService

Settingsのcredential変更でthreadをresetする場合は、MainのID・incarnation・provider・元thread、AuxiliaryのID・親・作成時刻・provider・元threadをtransaction内で照合し、対象fieldだけを条件付き更新する。本文、draft、messages、無関係な削除は全collection snapshotで巻き戻さない。後段失敗時は更新成功を確認できた行だけreverse CASし、結果不明の書込みへ無条件の逆書込みをしない。catalog import／resetでSession runtime metadataを反映する場合も同じ対象限定とowner照合を守る。

provider cleanupは短いownership境界の外で完了を待つ。同じproviderのcleanupが残る間はそのproviderの新規turn admissionを拒否し、無関係なproviderは止めない。rollbackは開始時のstorage ownerとreset境界を再確認する。復元に成功した場合はSettings／catalogとSessionのinvalidationを再配信し、Auxiliaryの更新通知は親Session IDへ送る。

## Lifecycle

`PersistentStoreLifecycleService`はstoreの初期化、close、再生成をまとめる。WAL maintenanceとshutdownはcurrent storage Worker generationに従い、旧generationの遅延応答を新しいDBへ適用しない。turnのterminal保存、取消、Window close後の継続、結果不明の扱いは[Session Run Lifecycle](session-run-lifecycle.md)、監査の読取とdetailは[Audit Log](audit-log.md)を参照する。
