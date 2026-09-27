# Electron Session Store

Session、Auxiliary、監査、設定、catalogの永続化はMainが公開するserviceとstorage Workerのtyped commandで扱う。SQLiteの実行owner、schema、tableは[Database Schema](database-schema.md)を参照する。Rendererは`window.withmate`のpreload APIを通し、DBへ直接接続しない。

## 読取と通知

Homeは`listSessionSummaryPage()`でrecent、pinned、open Sessionと検索結果をboundedに取得する。全Session本文をHomeへ送らない。Session Windowは対象Sessionを`getSession()`でhydrateし、変更通知を受けた対象を再取得する。summaryのinvalidationは`WindowBroadcastService`が`ids`または`all`として配信し、IDが上限を超えた場合は切り捨てず`all`へ切り替える。Homeは古いquery responseをgenerationで失効させ、既に取得したpageを必要範囲で再同期する。

## 書込みとowner

### SessionPersistenceService

`SessionPersistenceService`が作成、既存行更新、削除、期間削除を担当する。owner付きstorage command、cache projection、Window side effectの組み立ては`src-electron/session/session-persistence-assembly.ts`が担う。実行中のturnとcancelは`SessionRuntimeService`、Windowのclose／quitは`SessionWindowBridge`とlifecycle側で扱う。作成と既存行限定更新を分け、削除済み行を遅延更新で再作成しない。

### 実行設定と Send

Main / Auxiliary の表示中の実行設定は現在選択であり、DB への保存完了を表示・送信の前提にしない。Send は非同期処理を始める前に `executionOptions` を捕捉する。Main は provider / catalog / model / reasoning / 権限設定を検証し、その turn の prompt、Provider adapter、Audit に同じ設定を渡す。DB の Session、開始保存の応答、terminal 保存の応答から実行設定を再決定しない。

Main の `CurrentExecutionSelections` は会話 owner ごとの小さい選択値だけを保持する。同じアプリ内で Window を開き直した場合はこの値を復元し、storage generation の変更、owner の削除・incarnation の変更では破棄する。新規会話の初期値は provider ごとの現在選択を優先し、存在しなければ保存済みの直近値を使う。アプリ再起動では保存済み checkpoint から復元する。

選択 checkpoint は対象 metadata だけを更新する任意保存である。失敗は報告するが、現在選択の巻戻しや Send の阻止には使わない。開始時の user message と実行記録の必須保存とは区別する。新しい選択が C、実行中 turn の捕捉値が B の場合、Provider と Audit は B、UI と次の Send は C を維持する。

タイトルと Bookmark は対象 metadata / message だけを更新し、会話全体の置換を行わない。metadata の条件付き更新結果も必要な項目だけを返す。

### SettingsCatalogService

Settingsのcredential変更でthreadをresetする場合は、MainのID・incarnation・provider・元thread、AuxiliaryのID・親・作成時刻・provider・元threadをtransaction内で照合し、対象fieldだけを条件付き更新する。本文、draft、messages、無関係な削除は全collection snapshotで巻き戻さない。後段失敗時は更新成功を確認できた行だけreverse CASし、結果不明の書込みへ無条件の逆書込みをしない。catalog import／resetでSession runtime metadataを反映する場合も同じ対象限定とowner照合を守る。

provider cleanupは短いownership境界の外で完了を待つ。同じproviderのcleanupが残る間はそのproviderの新規turn admissionを拒否し、無関係なproviderは止めない。rollbackは開始時のstorage ownerとreset境界を再確認する。復元に成功した場合はSettings／catalogとSessionのinvalidationを再配信し、Auxiliaryの更新通知は親Session IDへ送る。

## Lifecycle

`PersistentStoreLifecycleService`はstoreの初期化、close、再生成をまとめる。WAL maintenanceとshutdownはcurrent storage Worker generationに従い、旧generationの遅延応答を新しいDBへ適用しない。turnのterminal保存、取消、Window close後の継続、結果不明の扱いは[Session Run Lifecycle](session-run-lifecycle.md)、監査の読取とdetailは[Audit Log](audit-log.md)を参照する。
