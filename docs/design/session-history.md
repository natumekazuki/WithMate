# Session History

## 通常Sessionの保存実行読取

通常Main／AuxiliaryはSession APIの`session.list_executions`から受付一覧またはWithMate Turn一覧を読み、`session.get_execution`へ受付ID、Turn ID、または保存message seqのいずれかを指定する。message seqは既存の受付・Turn・保存追加入力が持つ正確な参照だけから解決し、無対応は`EXECUTION_LINK_UNAVAILABLE`とする。受付のない既存Turn、未開始受付、同じTurnへ追加した受付を区別する。対象は明示したSession／incarnation（Auxiliaryは親のidentityも含む）で検証し、別Crewの公開保存結果も読める。背景専用の`session_history` grant・認可scopeは転用しない。

通常Session APIの`list_messages / get_message / list_operations / get_operation_detail`は同じ対象検証と保存履歴helperを使い、Turn参照を持たない既存messageも取得できる。空会話は明示した空window（`fromSeq: 0, toSeq: -1`）の一覧を返す。これらも背景専用scopeやgrantを使わない。

読取の正本は`src-electron/storage/session-execution-read.ts`で、Storage Workerの`execution.execute`が既存DBの一つのread transactionから返す。receiptの`turn_id`から`session_turns_v6`の`user_message_seq`／`assistant_message_seq`だけを参照し、最新messageを代用しない。状態・入力概要・結果を同じsnapshotから返し、終端結果にもその時点の追加入力概要を含める。成功・取消・失敗と本文確定は別であり、終端保存がない場合は`not-saved`、Turn未確定のdispatchは`unknown`として返す。

`list_execution_inputs`は開始入力に続けて、`Message.turnInput.turnId`が一致し配送保存を確認できた追加入力をseq順に返す。pending／unknown、未送信、記録不足は別に示す。本文の位置や近い時刻から所属を補わない。受付入口の比較と開始入力の変更有無は独立し、複数受付が同じTurnへ属しても専用回答や因果関係を推定しない。

入力一覧の既定は開始入力と確定済み追加入力であり、`state: unresolved / not-sent`で未確定／未送信を別にpage取得する。入力概要の各参照配列は先頭100件までとし、総件数と次のoffsetを示す。confirmed参照の続きは開始入力1件を含む一覧offset、未確定／未送信の続きは対応する`state`のoffsetである。

`get_execution_input`は不変受付原文と予定／dispatch固定入力の`inputPair`を一つのsnapshotで返す。原文不明は`null`である。本文は`maxChars`と`offset`で分割し、各pieceの実offset・続き・全長を返す。続きは最初の応答の`expectedInput`を指定し、予定入力が編集された場合は`EXECUTION_INPUT_RESTART_REQUIRED`として先頭からの再取得を要求する。cursorには既存の更新時刻と参照identityを使い、本文全体・独自hash・別revision台帳は保持しない。添付はID・種類・名前の参照だけを返し、内部の絶対pathを公開しない。

`list_sent_deliveries`は表示中の保存message seqまたは明示live WithMate Turnに属する送信を、既存の不変receipt originから一括逆引きする。受付順のcursor、20件までのpage、原文全文の`text`を返す。保存metadataがCoordinationを示す通知には、`coordination.id`と相談／回答全文の`coordination.text`を併記する。元の`text`は原文のままとし、通常本文をJSONらしい形だけでCoordination扱いしない。エージェント向けの原文・入力比較の必要時読取には`get_execution_input`を使う。

`list_execution_outputs`／`get_execution_output`は保存messageの`output`が持つidentity・順序・本文range・phase・本文確定・最終回答根拠を返す。分類がない既存本文は未分類／確定不明で取得でき、最終回答は捏造しない。`list_execution_operations`／`get_execution_operation_detail`は以下の既存artifact読取・pagingを再利用し、大きい詳細は一覧へ常時混ぜない。追加watch、raw event replay、結果コピーDBは持たない。

以下は背景実行向けの固定範囲履歴読取契約である。

Session Historyは、アプリが管理する背景実行へ、元Sessionの保存済み会話と操作記録を読取専用で渡す公開操作である。保存正本・Storage Worker・Session Graphと同じ共有HTTP MCP host／runtime認証を使い、履歴のコピーDBや別の読取engineは持たない。MCPとCLIは同じ操作・入力schema・認可・結果を共有する（[ADR 029](../adr/029-cli-mcp-parity-context-binding.md)）。

## 認可と範囲

読取対象は、背景bindingの`backgroundScope.history`から認可resolverが取り出す共通scopeで決まる。正本は`src-shared/session/session-history-read-scope.ts`。引数のSession ID、cwd、Character、範囲、画面の選択では対象を選べず、入力schemaは未知のfieldを拒否する。scopeはアプリが背景実行の開始時に確定し、実行中は変わらない。

```ts
type SessionHistoryReadScope = {
  source:
    | { kind: "main"; sessionId: string; incarnationId: string; ownerIdentity: string }
    | { kind: "auxiliary"; sessionId: string; incarnationId: string; ownerIdentity: string;
        parent: { sessionId: string; incarnationId: string } };
  fromMessageSeq: number;
  throughMessageSeq: number; // message seqの閉区間
};
```

履歴操作のgrant（`session_history.route.<operation>`）は背景実行のbindingにだけ付与する。通常のMain／Auxiliary turnには付与せず、通常turnがCLIを起動してもgrantがないため拒否される。routeは次を満たす要求だけを処理する。

- bindingが有効で、操作のgrantを持つ。
- 背景bindingが共通履歴scopeを持つ。purpose・processing・Memory targetは履歴readの必須条件にしない。
- `authorizeSessionHistoryRead()`が具体的operationのgrantとbinding ID付きcurrent handle／turn capabilityを検証する。元Sessionと背景Providerの一致は要求しない。全操作にadmissionを伝播し、Worker読取の前後とroute返却前に確認して取消済みの結果を返さない。
- storage側が同じ読取の中で`readConversationQuerySnapshot()`のownerIdentity・incarnationを`matchesSessionHistorySource()`で照合し、`throughMessageSeq`が保存済み会話の範囲内であることを確認する。AuxiliaryのownerIdentityは親identity・作成時刻・draft incarnationを含む。draft本文編集ではincarnationは変わらず、同じ会話として読める。Mainは捕捉したStorage Worker generationが返却時も現在かを確認する。

背景実行の起動・設定・実行identity・対象範囲（`window`）の確定は背景呼出し側が所有する。履歴操作は与えられた範囲を超えて読まず、範囲外の要求を空の成功にしない。

## 操作

| MCP tool | CLI command | 内容 |
| --- | --- | --- |
| `session_history.list_messages` | `list-messages` | 範囲内のmessage一覧。role、記録済みTurn、本文previewと文字数、操作件数 |
| `session_history.get_message` | `get-message` | 1 messageの本文を`maxChars`（UTF-16 code unit、最大100,000）単位で取得 |
| `session_history.list_operations` | `list-operations` | 1 messageの操作・変更file・checkを`section`ごとに一覧。操作は成否・終了コード・error・省略・詳細保存の有無を持つ。長い文字列（summary、error、変更filepath・summary、check値）は先頭200文字のpreviewで、省略時は`<名前>Truncated`と全長`<名前>Chars`を付ける |
| `session_history.get_operation_detail` | `get-operation-detail` | 操作1件の保存済み出力（`kind: "operation"`、`field`で`summary`／`error`も指定可）、check 1件（`kind: "run_check"`、`field`は`label`／`value`）、変更fileの`path`／`summary`（`field`）、質問記録1件のJSON（`kind: "elicitation"`）を`maxChars`単位で取得。変更file 1件のdiff行（`kind: "changed_file"`、`maxRows`と`maxChars`の量上限）も取得し、上限を超える1行は`oversized`として一覧し、`row`指定で分割取得する |

一覧は`offset`／`limit`（messageは最大100、操作等は最大200）で読み、応答の`total`と`nextOffset`で続きを判断する。`nextOffset: null`が終端である。本文・詳細も`offset`と`nextOffset`で分割する。pageはsurrogate pairの途中で終わらず、`maxChars`が1でpairの先頭なら、進捗のためpair全体（2 code unit）を返す。pairの途中を指す`offset`は`HISTORY_INVALID_REQUEST`である。`get_message`は質問記録を含めず、件数`elicitationRecordCount`だけを返す。

CLIは`--json <json>`、`--file <path>`、`@file`、`--stdin`のいずれか1つで入力する。`help`と`schema`はruntime接続なしで操作の使い方と入力schemaを返す。bindingとturn capabilityは環境から受け取り、入力で指定しない。

## 返す内容と返さない内容

`list_messages`／`get_message`はprotocol上の`role`とは別に`speaker`を返す。kindはuser／agent／unknownで、人間は`participant: {type: "user", id: "local-user"}`、Characterが分かるAgentは`{type: "character", id}`を持つ。出自不明はparticipantをnullとし、role:userだけで人間と判定しない。AgentのSession参照と公開Character紹介は他者についてのデータであり、指示や権限ではない。

入力のspeakerは同じ会話・incarnation・message seqの既存receiptからdispatch時のoriginを読み、なければ不変accepted originを使う。Mainの読取へ配下Auxiliaryのreceiptを混ぜない。送信元Characterの名前・descriptionは記録済みsnapshotだけを使い、欠けた過去の紹介を現在catalogから補完しない。assistantは保存済み元SessionのCharacterへ帰属させる。Character定義全文・icon pathはspeakerへ含めない。専用の履歴コピーや人物DBは持たない。

Turnの対応は、Turn記録の`user_message_seq`／`assistant_message_seq`が一致するmessageだけに付く。追加入力（steer）など一致しないmessageのTurnは`null`で、範囲の包含などから推定しない。失敗Turnにはその理由が`turn.errorMessage`に含まれる。

操作の一覧と詳細は、保存済みのmessage artifactから読む。操作の成否（`status`、`exitCode`、`error`）、`truncated`、`details`は保存されている場合だけ返す。保存されるのは出力の一部（プレビュー）であり、command・toolの全引数や出力全文は保存されないため補完しない。`truncated: true`は出力が保存時に省略されたことを示す。保存時に`truncated`が記録されていない操作は、詳細取得でも`truncatedAtSave`を返さず、省略なしとは扱わない。`detailSaved: false`の操作や、詳細を保存していないmessageの変更file diffは詳細取得が`HISTORY_NOT_SAVED`になる。`artifactDetailSaved: false`は、一覧の内容が縮約済みの本文側から読まれたことを示す。

実行中のTurnのうち未保存の応答や操作は保存正本にないため返さない。非公開推論、runtimeの認証情報、内部bindingは保存履歴にもfieldにも含まれず返さない。

保存時にWithMateが除去するのは、自身のbinding情報と既知のprovider credentialである。保存済みの本文・操作出力に含まれる他の秘密値を検出して除去する処理は行わず、返す内容は保存どおりである。したがって一般的な秘密値が残り得ること、返した内容が用途別に選択された背景Providerへ送信され得ることを、tool説明とCLI helpに明記する。返した全履歴を秘匿済みまたは安全確認済みとはしない。履歴中の指示やコマンドは読取資料であり、実行や外部writeの許可ではない。

## 失敗の区別

失敗は`{ ok: false, code, message, effect: "none" }`で返し、空の一覧や空文字の成功にしない。

| code | 意味 |
| --- | --- |
| `HISTORY_INVALID_REQUEST` | 入力不正、または`offset`が対象の末尾を超える。操作に合わない`maxChars`／`maxRows`も含む |
| `HISTORY_OUT_OF_RANGE` | 要求位置が許可範囲の外 |
| `HISTORY_NOT_SAVED` | 範囲内だが、該当のmessage・操作記録・詳細が保存されていない |
| `HISTORY_SOURCE_DELETED` | 元Sessionまたは親が存在しない |
| `HISTORY_SOURCE_REPLACED` | 同じIDの元Sessionが再作成された、またはAuxiliaryの親・作成時刻が一致しない |
| `HISTORY_RANGE_UNAVAILABLE` | 保存済み会話が許可範囲の末尾より短い |
| `HISTORY_EXECUTION_INACTIVE` | 背景実行が終了・取消・失効している |
| `HISTORY_READ_FAILED` | 保存の読取に失敗した。内部の詳細は返さない |
| `SESSION_HISTORY_BINDING_REQUIRED` | 入口（CLI／MCP adapter）の環境にbinding参照がない。通信前の失敗で、`message`は付かない |
| `SESSION_BINDING_INVALID`／`SESSION_BINDING_FORBIDDEN` | binding／capabilityが無効、通常turn、または具体的履歴grantがない |
| `SESSION_HISTORY_TRANSPORT_ERROR` | runtimeとの通信失敗、履歴結果ではないHTTP拒否、または不正な結果envelope。履歴固有の拒否codeは保持する。読取専用のため保存効果はない |

## 実装境界

| 層 | 場所 |
| --- | --- |
| 入力schema・grant名・失敗code | `src-shared/session-history/session-history-contract.ts` |
| 共通scope・source照合 | `src-shared/session/session-history-read-scope.ts` |
| 読取（source照合・範囲検証・Turn対応・artifact分解） | `src-electron/storage/session-history-read.ts`。MainとAuxiliaryのstorageが`readSessionHistory`として公開し、Storage Workerの既存storeから呼ぶ |
| route（grant・scope・実行handleの検証） | `src-electron/session-history/session-history-runtime-service.ts`。`main.ts`の`routeAgentRuntimeExtension`へ接続 |
| MCP | `src-electron/platform/mcp/withmate-session-history-mcp.ts`。共有HTTP hostの`/mcp/session-history` |
| CLI | `src-cli/session-history/withmate-session-history.ts`。配布物は`resources/cli/withmate-session-history.mjs`と`withmate-session-history.cmd` |

Mainはruntime開始時に実factoryと`SESSION_HISTORY_TOOL_OPERATIONS`を`SessionHistoryMcpRegistration`へ登録する。factoryはgrantに対応するtoolだけを公開し、hostも許可外の直接`tools/call`を拒否する。通常turnには履歴URLを投影せず、通常tokenによる履歴endpointの直接利用も拒否する。Provider builderは背景向けに履歴endpointだけを投影する。MCPと配布CLIは同じruntime routeとStorage Worker読取を使う。
