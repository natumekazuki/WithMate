# Repository Glossary

Repository Glossaryの正本はGit checkout内の`.withmate/glossary.yaml`である。Session UIはprimary checkoutの用語をSession messageとright paneへ表示し、MCPとCLIは認可されたcheckoutまたは明示したrepositoryを操作する。WithMate DB、Memory、Session data、provider promptへ用語集内容はコピーされない。

## File format

```yaml
schemaVersion: 1
entries:
  - term: Runtime binding
    aliases:
      - binding
    definition: >-
      Provider SessionとWithMate内のactor Sessionを結び付ける実行時の認可情報。
```

entryは`term`、省略可能な`aliases`、plain textの`definition`だけを持つ。`definition`にMarkdownやHTMLを書いても装飾として解釈されない。termとaliasはNFKC、lowercase、連続空白の正規化後にfile全体で一意でなければならない。

readだけでは`.withmate`や`glossary.yaml`を作成しない。初期fileはMCP／CLIの明示的なcreateを実行するか、repository側で直接作成する。

## Session UI

- message内の登録語またはaliasへannotationを表示する。code、URL、既存linkには表示しない。
- hoverまたはkeyboard focusで短い説明を表示する。click、Enter、Spaceで既存right paneのGlossary詳細を開く。
- 1 messageにつきTab stopは1件だけである。左右矢印、Home、Endでmessage内のannotationを移動し、Escapeでtooltipを閉じる。
- right paneは検索、一覧、詳細のread-only UIであり、作成、編集、削除、file初期化は行わない。
- Glossary詳細から一覧へ戻る操作の表示・accessible labelは`Back To Entries`とする。
- Glossary tabはfileの有無やentry件数、primary workspaceがGit checkoutかどうかにかかわらず表示する。`missing`、`valid`かつ0件、非Gitの`not-applicable`は正常状態としてstate labelと説明本文を表示せず、pane shellと必要な操作・accessibilityだけを残す。対処が必要な`invalid`、`unsupported`、`watch-error`は実失敗として原因を示し、常設の説明文や重複metadataは置かない。

fileが`invalid`、`unsupported`、`watch-error`、`missing`になった場合、または非Gitの`not-applicable`ではannotationを無効にする。message本文はそのまま表示し、fileが`valid`へ復旧すると再投影する。`not-applicable`はrenderer projection専用のtyped stateであり、Glossary operationのerror codeは`GLOSSARY_TARGET_INVALID`を使う。

## Managed Skill、MCP、CLI

WithMateから起動したprovider Sessionではmanaged `withmate-glossary` Skillを利用できる。公開operationは`list-targets`、`list`、`search`、`get`、`create`、`create-batch`、`update`、`delete`、`validate`の9操作である。MCPは`glossary.list_targets`、`glossary.create_batch`のように名前を対応させ、CLIと同じ入力意味・結果・エラー・保存契約を使う。operation schemaは`src-shared/glossary/glossary-operation-schema.ts`、利用上の判断はmanaged Skillの`SKILL.md`を参照する。

MCPはMainの共有localhost HTTP listenerの`/mcp/glossary`へ当turnの短命tokenで接続する。providerの一時設定へ注入し、永続設定やpromptへtokenを保存しない。Memory／Characterとlistenerを共有するが、protocol stateとapplication boundaryは独立している。手動stdio MCPも同じcanonical tool定義を利用する。

CLIと手動stdio MCPも起動中のWithMate runtimeへ接続し、既存のlocal runtime認証・instance/generation照合を通る。CLIがfileへ直接書き込む経路はなく、MCPと同じapplication serviceを使用する。GlossaryにはMemory CLI fallbackを設けない。

Session bindingがある場合は、既定の`{ "kind": "primary" }`、`list-targets`が返すopaqueな`{ "kind": "checkout", "checkoutId": "..." }`、または`{ "kind": "repository", "path": "<absolute-path>" }`を指定できる。いずれもbindingが許可したprimary checkoutに限る。無効・失効したbindingを無視して無binding操作へ降格せず、Session IDを自己申告して対象を切り替えることもできない。binding付きmutationはCLI／MCPともcaptured turnを必要とし、非同期actor解決前とfile commit前に有効性を照合する。取消・終了したturnへ新turnの権限を付け替えない。

Session bindingがない場合は、`list-targets`を含む各操作にrepository selectorを明示する。CLIでは`--repository <absolute-path>`でも指定できる。cwdやrepository名から対象を推定しない。create／create-batchはユーザーが追加を依頼した`mode: "explicit"`のみ利用でき、proactiveを黙ってexplicitへ置換しない。proactive createには有効なSession binding・turnとSettingsの上限が必要である。

CLIは`--json <json>`、`--file <path>`、`@file`、`--stdin`のいずれか1つから入力する。`help`は操作方法、`schema`は9操作の完全な公開入力schemaをruntime接続なしで返す。

```sh
withmate-glossary list --repository /absolute/path/to/repository
withmate-glossary get --repository /absolute/path/to/repository --term "Runtime binding"
withmate-glossary create --file entry-request.json
withmate-glossary schema
```

`entry-request.json`の例:

```json
{
  "selector": { "kind": "repository", "path": "/absolute/path/to/repository" },
  "mode": "explicit",
  "entry": { "term": "Runtime binding", "definition": "Provider Sessionの実行時認可情報。" }
}
```

createは既存の異なる定義を上書きせず、create-batchは全件適用または競合として扱う。updateとdeleteは明示されたユーザー要求に限り、`explicitUserRequest: true`とread時の`revision`を`expectedRevision`へ渡す。競合ではcurrent valueを再取得して要求を評価し直す。CLIの入力不正は`GLOSSARY_INVALID_REQUEST`であり、MCP SDKの入力検証エラーも同じ入力不正として扱う。transportを切り替えて認可・検証・競合エラーを迂回しない。

`effect: unknown`では自動retryせず、current valueをreadし直してからユーザーへ確認する。`outcome: converged`は現在値が要求postconditionに一致するという意味であり、そのretry試行がwriteしたことを示さない。
