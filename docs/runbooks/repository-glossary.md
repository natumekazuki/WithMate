# Repository Glossary

Repository Glossaryは、Sessionのprimary Git checkoutにある`.withmate/glossary.yaml`を読み取り、Session messageとright paneへ用語の説明を表示する。WithMate DB、Memory、Session data、provider promptへ用語集内容はコピーされない。

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

readだけでは`.withmate`や`glossary.yaml`を作成しない。初期fileはSession内のmanaged `withmate-glossary` Skillから明示的なcreateを実行するか、repository側で直接作成する。

## Session UI

- message内の登録語またはaliasへannotationを表示する。code、URL、既存linkには表示しない。
- hoverまたはkeyboard focusで短い説明を表示する。click、Enter、Spaceで既存right paneのGlossary詳細を開く。
- 1 messageにつきTab stopは1件だけである。左右矢印、Home、Endでmessage内のannotationを移動し、Escapeでtooltipを閉じる。
- right paneは検索、一覧、詳細のread-only UIであり、作成、編集、削除、file初期化は行わない。
- Glossary tabはfileの有無やentry件数、primary workspaceがGit checkoutかどうかにかかわらず表示する。`missing`、`valid`かつ0件、非Gitの`not-applicable`は正常状態としてstate labelと説明本文を表示せず、pane shellと必要な操作・accessibilityだけを残す。対処が必要な`invalid`、`unsupported`、`watch-error`は実失敗として原因を示し、常設の説明文や重複metadataは置かない。

fileが`invalid`、`unsupported`、`watch-error`、`missing`になった場合、または非Gitの`not-applicable`ではannotationを無効にする。message本文はそのまま表示し、fileが`valid`へ復旧すると再投影する。`not-applicable`はrenderer projection専用のtyped stateであり、Glossary operationのerror codeは従来どおり`GLOSSARY_TARGET_INVALID`を使う。

## Managed Skill、MCP、CLI

WithMateから起動したprovider Sessionではmanaged `withmate-glossary` Skillを利用できる。公開operationは`list-targets`、`list`、`search`、`get`、`create`、`create-batch`、`update`、`delete`、`validate`である。operation schemaと利用例はmanaged Skillの`SKILL.md`を参照する。

CLIとMCPは起動中のprovider Sessionのruntime bindingを必要とする。Session IDやabsolute pathを入力して別checkoutへ切り替えることはできない。`list-targets`が返すprimary targetだけを使用する。

updateとdeleteはread時の`revision`を`expectedRevision`へ渡す。`effect: unknown`では自動retryせず、current valueをreadし直してからユーザーへ確認する。`outcome: converged`は現在値が要求postconditionに一致するという意味であり、そのretry試行がwriteしたことを示さない。
