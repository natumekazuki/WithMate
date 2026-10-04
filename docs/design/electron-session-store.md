# Electron Session Store

Session、Auxiliary、監査、設定、catalogの永続化はMainが公開するserviceとstorage Workerのtyped commandで扱う。SQLiteの実行owner、schema、tableは[Database Schema](database-schema.md)を参照する。Rendererは`window.withmate`のpreload APIを通し、DBへ直接接続しない。

## 読取と通知

Homeは`listSessionSummaryPage()`でrecent、pinned、open Sessionと検索結果をboundedに取得する。全Session本文をHomeへ送らない。Session Windowは対象IDの`getSessionSummary()`で基本情報を取得し、`getSession()`による会話のhydrateと独立してheaderやFilesを表示する。summary取得はmessage、stream、artifactのtableを読まず、全件一覧も取得しない。summaryから作った表示用projectionを会話の保存・送信には使わない。変更通知を受けた対象を再取得し、会話取得の失敗は既に取得した情報を保持したまま局所的に再試行できる。

summaryのinvalidationは`WindowBroadcastService`が`ids`または`all`として配信し、IDが上限を超えた場合は切り捨てず`all`へ切り替える。Homeは古いquery responseをgenerationで失効させ、既に取得したpageを必要範囲で再同期する。

## 書込みとowner

ドロップが許されない確定データと、次回復元のための任意checkpointを区別する。任意checkpointは現在値の適用・使用とは別ラインで保存し、保存の遅延・失敗を現在値の巻戻し、操作や実行の待機条件にしない。再起動時に未保存の現在値を復元できないことは許容する。

Session identity、確定message、turnの実行記録・Audit、provider thread、Auxiliary draft、Character定義、Bookmark等の明示的な整理操作、Settingsの明示的なSave、catalog更新は必須保存の契約を維持する。任意保存との切分けは、入力検証、owner照合、実行中の操作制約を緩和しない。

### SessionPersistenceService

`SessionPersistenceService`が作成、既存行更新、削除、期間削除を担当する。owner付きstorage command、cache projection、Window side effectの組み立ては`src-electron/session/session-persistence-assembly.ts`が担う。実行中のturnとcancelは`SessionRuntimeService`、Windowのclose／quitは`SessionWindowBridge`とlifecycle側で扱う。作成と既存行限定更新を分け、削除済み行を遅延更新で再作成しない。

### 実行設定と Send

Main / Auxiliary の表示中の実行設定は現在選択であり、Model・Depth・Approval・SandboxのいずれもDBへの保存完了を表示・送信の前提にしない。Send は非同期処理を始める前に `executionOptions` を捕捉する。Main は provider / catalog / model / reasoning / 権限設定を検証し、その turn の prompt、Provider adapter、Audit に同じ設定を渡す。DB の Session、開始保存の応答、terminal 保存の応答から実行設定を再決定しない。

Main の `CurrentExecutionSelections` は会話 owner ごとの小さい選択値だけを保持する。同じアプリ内で Window を開き直した場合はこの値を復元し、storage generation の変更、owner の削除・incarnation の変更では破棄する。新規会話の初期値は provider ごとの現在選択を優先し、存在しなければ保存済みの直近値を使う。アプリ再起動では保存済み checkpoint から復元する。

選択 checkpoint は対象 metadata だけを更新する任意保存である。受理済みの選択では checkpoint 失敗を報告するが、現在選択の巻戻しや Send の阻止には使わない。選択自体が拒否された場合は、現在選択を再取得して表示を戻し、理由を示す。開始時の user message と実行記録の必須保存とは区別する。新しい選択が C、実行中 turn の捕捉値が B の場合、Provider と Audit は B、UI と次の Send は C を維持する。

タイトルと Bookmark は対象 metadata / message だけを更新し、会話全体の置換を行わない。metadata の条件付き更新結果も必要な項目だけを返す。

Mainのtitle更新は、storage commandの成功をcommit境界とする。保存前の失敗はrejectし、commit後のcache更新・Window通知失敗は`SetSessionTitleResult`の`status: "committed"`と`projectionUpdated: false`で返す。storage ownerの失効も、成功したstorage commandの後では投影失敗として扱い、新しいownerのcacheへ書き込まない。Rendererは保存済みtitleを保持し、通知・投影失敗時は`getSessionSummary()`の正本からtitleだけを復旧する。通知失敗と復旧失敗は保存失敗と区別して表示し、保存の再送やSession全体のrollbackは行わない。応答と復旧readはSession ID、incarnation、最新のtitle保存requestが一致する場合だけ反映し、別会話や後続のtitle更新へ古い結果を適用しない。

最新のtitle保存がrejectした場合も、先行保存の遅延応答を捨てたことでcommit済みtitleが表示から失われないよう、正本summaryからtitleだけを再照合する。編集入力と保存失敗の表示は保持し、再照合を新しい保存成功とは扱わない。

### SettingsCatalogService

Header・Action Dock・Side Paneの復元設定は、Rendererへ即時適用し、Mainでも変更された項目の現在値を保持する。DB保存は任意checkpointとして別ラインで行い、同じアプリ内の設定再取得では現在値を重ねる。保存失敗は診断ログへ残すが、表示を巻き戻さない。Settings Windowの明示的なSaveの必須保存とは区別する。

layoutの現在値はserviceの寿命中保持し、App SettingsまたはDB全体のreset成功時に破棄する。resetは任意checkpointの完了を待たず、未開始の旧checkpointを失効させる。dispatch前には既存のstorage ownerを照合し、旧serviceのqueueを新しいDB世代へ持ち越さない。

Settingsのcredential変更でthreadをresetする場合は、MainのID・incarnation・provider・元thread、AuxiliaryのID・親・作成時刻・provider・元threadをtransaction内で照合し、対象fieldだけを条件付き更新する。本文、draft、messages、無関係な削除は全collection snapshotで巻き戻さない。後段失敗時は更新成功を確認できた行だけreverse CASし、結果不明の書込みへ無条件の逆書込みをしない。catalog import／resetでSession runtime metadataを反映する場合も同じ対象限定とowner照合を守る。

provider cleanupは短いownership境界の外で完了を待つ。同じproviderのcleanupが残る間はそのproviderの新規turn admissionを拒否し、無関係なproviderは止めない。rollbackは開始時のstorage ownerとreset境界を再確認する。復元に成功した場合はSettings／catalogとSessionのinvalidationを再配信し、Auxiliaryの更新通知は親Session IDへ送る。

## Lifecycle

`PersistentStoreLifecycleService`はstoreの初期化、close、再生成をまとめる。WAL maintenanceとshutdownはcurrent storage Worker generationに従い、旧generationの遅延応答を新しいDBへ適用しない。turnのterminal保存、取消、Window close後の継続、結果不明の扱いは[Session Run Lifecycle](session-run-lifecycle.md)、監査の読取とdetailは[Audit Log](audit-log.md)を参照する。
