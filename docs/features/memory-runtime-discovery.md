# Memory runtimeの複数instance discovery

## 概要

同じOS userで複数のWithMate instanceが起動する場合に、CLI、MCP、providerが接続先のMemory runtimeを取り違えないためのdiscovery機構です。

各WithMate processは起動ごとのapplication instance IDを持ちます。Memory runtimeも起動ごとのgenerationを持ち、共有runtime registryへ個別に公開します。

## operator CLI

operator CLIはactiveなMemory runtime候補を確認して接続先を決めます。

```text
withmate-memory instances
withmate-memory status --all
withmate-memory status --instance <application-instance-id>
withmate-memory status --instance <application-instance-id> --generation <runtime-generation-id>
```

selectorがない場合の動作は次のとおりです。

- active候補が0件: unavailableまたはstale error
- active候補が1件: その候補を選択
- active候補が複数件: `WITHMATE_RUNTIME_AMBIGUOUS`

`--instance`と`--generation`は完全一致だけを許可します。起動順、更新日時、build channelを優先順位には使いません。

## Session-bound providerとMCP

Sessionから起動したproviderには、起動元のapplication instance IDとMemory generationを環境変数で渡します。bound clientは指定されたruntimeだけを使用し、別instanceへfallbackしません。

runtime再起動でgenerationが変わった場合は、以前のbindingを新しいruntimeへ読み替えず、generation mismatchとして失敗します。

## 共有registry

Windowsの既定registry rootは`%LOCALAPPDATA%\WithMate\runtime-discovery\v1`です。entryには次のsafe metadataだけを保持します。

- application instance ID
- runtime kindとgeneration
- build channel
- process diagnostic
- lease
- credential fileへの安全な参照

credential本文、secret、Memory本文、binding reference、個人pathはentryへ保存しません。

## leaseとstale候補

runtimeはleaseを更新します。process終了やcrashで更新が止まった候補はactive対象から除外します。stale候補を明示した場合は`WITHMATE_RUNTIME_STALE`を返します。

registryのpublish、renew、unpublish、rollbackはprocess間lockで直列化します。legacy pointerとのhandoff中も、他processが作成したentryやpointerを無条件で削除しません。

## legacy discovery

v6.3.24以前が使用するsingle pointerは互換projectionとして扱います。複数instanceの選択に使用する正本は共有registryです。

旧instanceは新registryへ候補を公開しないため、新CLIから新instanceと旧instanceを同じ候補集合として列挙することはできません。

## 関連文書

- [ADR 023: Multi-instance Runtime Discovery](../adr/023-multi-instance-runtime-discovery.md)
- [Agent Runtime Binding Authority Boundary](../adr/021-agent-runtime-binding-authority-boundary.md)
- [V6 Memory Foundation](../design/v6-memory-foundation.md)
