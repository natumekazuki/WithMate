# Persistence Worker Repository Read Model

## Scope

この文書は、Persistence WorkerがCP2へ提供するRepository read契約を定める。SQLite tableと不変条件は`docs/design/multi-agent-persistence.md`、Worker lifecycleとresponse上限は`docs/design/persistence-worker-lifecycle.md`を正本とする。

Main / Application Serviceはcallerの認可を行う。Persistence Workerは認証主体を扱わないが、受け取った`workspaceKey`、`sessionId`、`runId`、child relationをSQL JOINで再検証する。IDだけを指定したreadは提供せず、所属不一致は存在の有無を漏らさない`not_found`へ畳む。

## Public surface

CP2は`RepositoryReadClient`を使用し、raw operation名を直接組み立てない。public readは次を含む。

- Session keyset pageとSession detail
- Message timeline
- Run detailとRunEvent page
- RunOutput category countとsummary page
- Message本文とstored output payloadのscoped chunk
- child result delivery page

ProviderBinding、RunAttempt、RunDispatchのrecovery projectionはMain内部専用とし、Renderer / CLIへexternal IDやdispatch情報を直接公開しない。repair、collect、state収束はwriteであるためS6の責務とする。

## Pagination and snapshot

Session pageは`(last_activity_at DESC, id DESC)`、Message、RunEvent、RunOutput、child deliveryは`ordinal ASC`のkeyset paginationを使う。limitはquery種別ごとに既定値と最大値を固定し、`limit + 1`件で次pageの有無を判定する。

cursorは`v1.` prefixを持つopaque valueで、query種別、構造化したscope / filterのSHA-256 digest、sort keyを含む。scope値の長さや区切り文字に依存してcursorが衝突または肥大化しないよう、scope本文は格納しない。別workspace、別Session、別Run、別filterへの流用、未知field、非canonical encodingは`cursor_invalid`として拒否する。cursorは認可tokenではなく、SQL predicateにはrequestで再指定されたscopeをbindする。

Session keysetのsort keyに含まれるSession IDはschemaで最大1024文字に制限する。これにより、正規のSession rowから生成したcursorは2048文字のdecode上限とprotocol response上限へ収まる。

Session pageとordinal pageは、件数limitに加えてJSON本体を192 KiBで打ち切り、最後に収容できたrowから次cursorを返す。可変長summaryやinline本文が複数並んでも、protocol metadataを含む256 KiB response上限を超過させない。単一rowの公開projectionだけでbudgetを超える場合は、rowを無言で消さず、ordinalを含む`response_size_limit` omissionを返して後続rowへ進める。

各operationは単一SQL statementのsnapshotを返す。page間でsnapshotは維持せず、長寿命read transactionも保持しない。Session pageはrecent feedとして更新により並びが変わり得るため、最新状態が必要なcallerは先頭からrefreshする。ordinalがappend-onlyのtimeline、event、outputでは取得済みordinalより後を追跡する。

## Bounded query contract

Session pageは対象Sessionをactivity indexとlimitで先に確定し、そのpage内だけactive / latest Runを既存indexでprobeする。execution stateはnon-terminal Runがあれば`running`、なければlatest terminal phase、Runがなければ`not_started`として導出する。Session rowへexecution stateを保存しない。

Message、RunEvent、RunOutput summary、child result、count queryは`run_output_payloads.content`をJOINまたはSELECTしない。RunEventの`dedupe_key`、workspace照合用column、RunOutputのProvider内部IDは公開projectionへ含めない。RunOutput countはmetadata tableから導出し、summary pageはpayload metadataとBLOBを暗黙hydrateしない。category filterの有無でSQLを分け、指定時は`run_output_items_run_category_ordinal_idx`を使う。

Message本文は最大4 MiBであり、Worker response上限を超え得る。64 KiB以下だけtimelineへinlineし、それより大きい本文はbyte lengthと`chunked` stateを返す。Sessionの追加directory JSONとRun execution snapshotも同じinline上限を使う。各JSON本文とstored payloadのchunk operationはscopeを再検証し、最大256 KiBのrange readを専有`ArrayBuffer`でtransferする。最終response上限はJSON metadataとの合計で判定する。

## Validation gate

- Session pageが1 statementでexecution stateを返し、page limitより前に全Runを集計しない。
- Message / Event / Output pageが対応するordinal indexを使う。
- summary、count、timelineのquery planに`run_output_payloads`が現れない。
- large fixtureでも返却row数とresponse sizeが固定上限内に収まる。
- scope不一致、cursor流用、limit超過が明示失敗へ収束する。

single connectionは上記代表queryで有界に処理できている限り維持する。複数read connectionはquery latencyまたはFIFO待ちが実測上の問題になった場合だけ再検討する。
