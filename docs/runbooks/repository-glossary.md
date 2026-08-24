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
- Glossary tabはfileの有無やentry件数にかかわらず表示し、missing、空、invalid、unsupported、watch errorを同じ面で区別する。

fileがinvalid、unsupported、missingになった場合はannotationを無効にする。message本文はそのまま表示し、fileがvalidへ復旧すると再投影する。

## Managed Skill、MCP、CLI

WithMateから起動したprovider Sessionではmanaged `withmate-glossary` Skillを利用できる。公開operationは`list-targets`、`list`、`search`、`get`、`create`、`create-batch`、`update`、`delete`、`validate`である。operation schemaと利用例はmanaged Skillの`SKILL.md`を参照する。

CLIとMCPは起動中のprovider Sessionのruntime bindingを必要とする。Session IDやabsolute pathを入力して別checkoutへ切り替えることはできない。`list-targets`が返すprimary targetだけを使用する。

updateとdeleteはread時の`revision`を`expectedRevision`へ渡す。`effect: unknown`では自動retryせず、current valueをreadし直してからユーザーへ確認する。`outcome: converged`は現在値が要求postconditionに一致するという意味であり、そのretry試行がwriteしたことを示さない。
