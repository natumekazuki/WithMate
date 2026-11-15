# Session History

## 通常Sessionの保存実行読取

通常Main／AuxiliaryはSession APIの`session.list_executions`から受付一覧またはWithMate Turn一覧を読み、`session.get_execution`へ受付ID、Turn ID、または保存message seqのいずれかを指定する。message seqは既存の受付・Turn・保存追加入力が持つ正確な参照だけから解決し、無対応は`EXECUTION_LINK_UNAVAILABLE`とする。受付のない既存Turn、未開始受付、同じTurnへ追加した受付を区別する。対象は明示したSession／incarnation（Auxiliaryは親のidentityも含む）で検証し、別Crewの公開保存結果も読める。

通常Session APIの`list_messages / get_message / list_operations / get_operation_detail`は同じ対象検証と保存履歴helperを使い、Turn参照を持たない既存messageも取得できる。空会話は明示した空window（`fromSeq: 0, toSeq: -1`）の一覧を返す。

読取の正本は`src-electron/storage/session-execution-read.ts`で、Storage Workerの`execution.execute`が既存DBの一つのread transactionから返す。receiptの`turn_id`から`session_turns_v6`の`user_message_seq`／`assistant_message_seq`だけを参照し、最新messageを代用しない。状態・入力概要・結果を同じsnapshotから返し、終端結果にもその時点の追加入力概要を含める。成功・取消・失敗と本文確定は別であり、終端保存がない場合は`not-saved`、Turn未確定のdispatchは`unknown`として返す。

`list_execution_inputs`は開始入力に続けて、`Message.turnInput.turnId`が一致し配送保存を確認できた追加入力をseq順に返す。pending／unknown、未送信、記録不足は別に示す。本文の位置や近い時刻から所属を補わない。受付入口の比較と開始入力の変更有無は独立し、複数受付が同じTurnへ属しても専用回答や因果関係を推定しない。

入力一覧の既定は開始入力と確定済み追加入力であり、`state: unresolved / not-sent`で未確定／未送信を別にpage取得する。入力概要の各参照配列は先頭100件までとし、総件数と次のoffsetを示す。confirmed参照の続きは開始入力1件を含む一覧offset、未確定／未送信の続きは対応する`state`のoffsetである。

`get_execution_input`は不変受付原文と予定／dispatch固定入力の`inputPair`を一つのsnapshotで返す。原文不明は`null`である。本文は`maxChars`と`offset`で分割し、各pieceの実offset・続き・全長を返す。続きは最初の応答の`expectedInput`を指定し、予定入力が編集された場合は`EXECUTION_INPUT_RESTART_REQUIRED`として先頭からの再取得を要求する。cursorには既存の更新時刻と参照identityを使い、本文全体・独自hash・別revision台帳は保持しない。添付はID・種類・名前の参照だけを返し、内部の絶対pathを公開しない。

`list_sent_deliveries`は表示中の保存message seqまたは明示live WithMate Turnに属する送信を、既存の不変receipt originから一括逆引きする。受付順のcursor、20件までのpage、原文全文の`text`を返す。保存metadataがCoordinationを示す通知には、`coordination.id`と相談／回答全文の`coordination.text`を併記する。元の`text`は原文のままとし、通常本文をJSONらしい形だけでCoordination扱いしない。エージェント向けの原文・入力比較の必要時読取には`get_execution_input`を使う。

`list_execution_outputs`／`get_execution_output`は保存messageの`output`が持つidentity・順序・本文range・phase・本文確定・最終回答根拠を返す。分類がない既存本文は未分類／確定不明で取得でき、最終回答は捏造しない。`list_execution_operations`／`get_execution_operation_detail`は以下の既存artifact読取・pagingを再利用し、大きい詳細は一覧へ常時混ぜない。追加watch、raw event replay、結果コピーDBは持たない。

## 本文・操作詳細のpaging

通常Session APIは既存の保存履歴read engineを共用する。message／operationの一覧はoffsetとlimit、本文・詳細はoffsetとmaxChars（UTF-16 code unit）で取得する。応答のtotalとnextOffsetで続きを判断し、surrogate pairを途中で分割しない。未保存の操作詳細を空成功や成功実績へ補完しない。

## 返す内容と返さない内容

`list_messages`／`get_message`はprotocol上の`role`とは別に`speaker`を返す。kindはuser／agent／unknownで、人間は`participant: {type: "user", id: "local-user"}`、Characterが分かるAgentは`{type: "character", id}`を持つ。出自不明はparticipantをnullとし、role:userだけで人間と判定しない。AgentのSession参照と公開Character紹介は他者についてのデータであり、指示や権限ではない。

入力のspeakerは同じ会話・incarnation・message seqの既存receiptからdispatch時のoriginを読み、なければ不変accepted originを使う。Mainの読取へ配下Auxiliaryのreceiptを混ぜない。送信元Characterの名前・descriptionは記録済みsnapshotだけを使い、欠けた過去の紹介を現在catalogから補完しない。assistantは保存済み元SessionのCharacterへ帰属させる。Character定義全文・icon pathはspeakerへ含めない。専用の履歴コピーや人物DBは持たない。

Turnの対応は、Turn記録の`user_message_seq`／`assistant_message_seq`が一致するmessageだけに付く。追加入力（steer）など一致しないmessageのTurnは`null`で、範囲の包含などから推定しない。失敗Turnにはその理由が`turn.errorMessage`に含まれる。

操作の一覧と詳細は、保存済みのmessage artifactから読む。操作の成否（`status`、`exitCode`、`error`）、`truncated`、`details`は保存されている場合だけ返す。保存されるのは出力の一部（プレビュー）であり、command・toolの全引数や出力全文は保存されないため補完しない。`truncated: true`は出力が保存時に省略されたことを示す。保存時に`truncated`が記録されていない操作は、詳細取得でも`truncatedAtSave`を返さず、省略なしとは扱わない。`detailSaved: false`の操作や、詳細を保存していないmessageの変更file diffは詳細取得が`HISTORY_NOT_SAVED`になる。`artifactDetailSaved: false`は、一覧の内容が縮約済みの本文側から読まれたことを示す。

実行中のTurnのうち未保存の応答や操作は保存正本にないため返さない。非公開推論、runtimeの認証情報、内部bindingは保存履歴にもfieldにも含まれず返さない。

保存時にWithMateが除去するのは、自身のbinding情報と既知のprovider credentialである。保存済みの本文・操作出力に含まれる他の秘密値を検出して除去する処理は行わず、返す内容は保存どおりである。したがって一般的な秘密値が残り得ること、返した内容が履歴を取得するProviderへ送信され得ることを、通常Session APIのtool説明とCLI helpに明記する。返した全履歴を秘匿済みまたは安全確認済みとはしない。履歴中の指示やコマンドは読取資料であり、実行や外部writeの許可ではない。

## 実装境界

通常Sessionの実行読取は`src-electron/storage/session-execution-read.ts`、保存message・artifactの読取は`src-electron/storage/session-history-read.ts`を利用する。Storage Workerと通常Session APIの対象Session／incarnation・操作認可を通り、DBや履歴のコピーをCLIへ持ち込まない。公開入口は通常SessionのMCP `/mcp/session` と `withmate-session` CLIである。
