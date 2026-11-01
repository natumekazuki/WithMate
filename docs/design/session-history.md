# Session History

Session Historyは、アプリが管理する背景実行へ、元Sessionの保存済み会話と操作記録を読取専用で渡す公開操作である。保存正本・Storage Worker・Session Graphと同じ共有HTTP MCP host／runtime認証を使い、履歴のコピーDBや別の読取engineは持たない。MCPとCLIは同じ操作・入力schema・認可・結果を共有する（[ADR 029](../adr/029-cli-mcp-parity-context-binding.md)）。

## 認可と範囲

読取対象は、背景実行のbindingが持つ`authoritySnapshot.sessionHistoryScope`だけで決まる。引数のSession ID、cwd、Character、範囲、画面の選択では対象を選べず、入力schemaは未知のfieldを拒否する。scopeはアプリが背景実行の開始時に確定し、実行中は変わらない。

```ts
type SessionHistoryReadScope = {
  source:
    | { kind: "main"; sessionId: string; incarnationId: string }
    | { kind: "auxiliary"; sessionId: string; parentSessionId: string; parentIncarnationId: string; createdAt: string; draftIncarnation: string };
  window: { fromSeq: number; toSeq: number }; // message seqの閉区間
};
```

履歴操作のgrant（`session_history.route.<operation>`）は背景実行のbindingにだけ付与する。通常のMain／Auxiliary turnには付与せず、通常turnがCLIを起動してもgrantがないため拒否される。routeは次を満たす要求だけを処理する。

- bindingが有効で、操作のgrantを持つ。
- `sessionHistoryScope`が形式どおりに存在する。
- 要求のturn capabilityが現在の実行handleと一致する。全操作が対象で、読取の完了後にも再確認し、取り消された実行には結果を返さない。
- storage側が同じ読取の中で元Sessionの存在とincarnationを照合し、`toSeq`が保存済み会話の範囲内であることを確認する。Mainはincarnation、Auxiliaryは自身の作成時刻・保存済みdraftのincarnation（同じIDで再作成すると変わる）と、親のID・incarnationが一致しなければならない。draft本文の編集ではincarnationは変わらず、同じ会話として読める。

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
| `HISTORY_SCOPE_INVALID` | bindingに有効な履歴scopeがない |
| `HISTORY_EXECUTION_INACTIVE` | 背景実行が終了・取消・失効している |
| `HISTORY_READ_FAILED` | 保存の読取に失敗した。内部の詳細は返さない |
| `SESSION_HISTORY_BINDING_REQUIRED` | 入口（CLI／MCP adapter）の環境にbinding参照がない。通信前の失敗で、`message`は付かない |
| `SESSION_BINDING_INVALID`／`SESSION_BINDING_FORBIDDEN` | routeでbindingが無効、または履歴grantがない |
| `SESSION_HISTORY_TRANSPORT_ERROR` | runtimeとの通信に失敗した。読取専用のため保存効果はない |

## 実装境界

| 層 | 場所 |
| --- | --- |
| 入力schema・grant名・scope型・失敗code | `src-shared/session-history/session-history-contract.ts` |
| 読取（source照合・範囲検証・Turn対応・artifact分解） | `src-electron/storage/session-history-read.ts`。MainとAuxiliaryのstorageが`readSessionHistory`として公開し、Storage Workerの既存storeから呼ぶ |
| route（grant・scope・実行handleの検証） | `src-electron/session-history/session-history-runtime-service.ts`。`main.ts`の`routeAgentRuntimeExtension`へ接続 |
| MCP | `src-electron/platform/mcp/withmate-session-history-mcp.ts`。共有HTTP hostの`/mcp/session-history` |
| CLI | `src-cli/session-history/withmate-session-history.ts`。配布物は`resources/cli/withmate-session-history.mjs`と`withmate-session-history.cmd` |

共有HTTP hostは履歴endpointを提供するが、Providerへ渡す接続情報（`ProviderAgentRuntimeBindingProjection.managedMcp`の各builder）は通常turn向けには履歴endpointを含めない。背景実行へだけ公開する選択は背景呼出し側が行う。
