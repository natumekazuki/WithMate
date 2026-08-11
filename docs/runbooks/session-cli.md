# Session CLI 運用手順

## 目的

`withmate-session`は、起動中のデスクトップアプリが所有するSession runtimeを通じて通常Sessionを操作する。アプリケーションのdatabaseやprovider adapterへ直接アクセスしない。

## 利用条件

WithMateを起動しておく必要がある。Windows installerはinstall directoryへ`withmate-session.cmd`を配置し、user `Path` registry値を変更せずに`%LOCALAPPDATA%\Microsoft\WindowsApps\withmate-session.cmd` aliasを作成する。

runtime接続を確認する。

```powershell
withmate-session status
```

WithMateを起動せずにCLI schemaを確認する。

```powershell
withmate-session schema
```

## Turn操作

current model catalogを確認する。入力JSONは不要である。

```powershell
withmate-session runtime catalog
```

CLIは次のTurn commandを公開する。

- `turn run`
- `turn enqueue`
- `turn list`
- `turn get`
- `turn cancel`

operation inputはJSON objectとし、`--json`、`--file`、`--stdin`のいずれか一つで渡す。CLIがversioned Session runtime request envelopeへ変換する。

```powershell
withmate-session turn get --json '{"sessionId":"SESSION_ID","executionId":"EXECUTION_ID"}'
withmate-session turn cancel --json '{"sessionId":"SESSION_ID","executionId":"EXECUTION_ID","idempotencyKey":"CANCEL_KEY"}'
```

## Session操作

通常Sessionの作成、一覧、取得、名前変更を公開する。

```powershell
withmate-session session create --json '{"title":"作業","provider":"codex","catalogRevision":1,"workspace":{"kind":"directory","path":"C:\\work"}}'
withmate-session session list --json '{}'
withmate-session session get --json '{"sessionId":"SESSION_ID"}'
withmate-session session rename --json '{"sessionId":"SESSION_ID","title":"新しい名前"}'
```

`session.create`と`session.rename`の`idempotencyKey`は省略でき、省略時はCLI/MCP adapterが一度だけUUIDを生成する。再送時は同じkeyを明示する。

既定はJSON出力である。人が読む要約には`--format text`を使う。scriptはJSON出力を使い、messageではなく`ok`、`error.code`、`error.retryable`、`error.effect`を判定する。

## Exit code

| Exit code | 意味 |
| --- | --- |
| `0` | 成功 |
| `1` | CLI usageまたはinput parse失敗 |
| `2` | runtime未起動、dispatch前の接続失敗、またはidentity mismatch |
| `3` | Session application error |
| `4` | operation requestがdispatchされた可能性のあるtransport failure |

exit code `4`の後は、同じidentifierでoperation状態を確認し、mutationを再送する場合は同じidempotency keyを使う。

## MCP server

Session MCPは同じ配布物のstdio commandとして起動する。

```powershell
withmate-session mcp-server
```

MCP clientにはこのcommandをserver commandとして登録する。公開toolは`runtime.catalog`、`session.create`、`session.list`、`session.get`、`session.rename`、`turn.run`、`turn.enqueue`、`turn.list`、`turn.get`、`turn.cancel`で、入力shapeはMCPの`tools/list`を正本とする。application errorはversioned `structuredContent`と`isError: true`で返る。terminal `failed` executionはoperation受付済みのresultであり、tool errorではない。
