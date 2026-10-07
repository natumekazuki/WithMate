# ADR 027: 共有localhost HTTP MCPの接続をactorとlogical turnへ固定する

- 状態: Accepted
- 日付: 2026-10-07
- 部分置換対象: ADR 021・023・024のmanaged MCP経路の接続前本人確認、およびfallback reporterの所有者

## 適用状態

採用済み・未適用。共有HTTP MCPとprovider配線は未実装であり、現行のstdio MCP、runtime discovery、同一接続のidentity challengeは引き続き適用する。本判断は新しいprovider → 共有HTTP MCPの入口に限定し、operator CLI、agent-bound CLI fallback、MCPから既存runtime exchangeへの内側の接続を置換しない。

## 背景

Memory／CharacterとGlossaryのmanaged MCPは、接続ごとにstdio helper processを起動する。helper数と常駐負荷を減らすため、Electron Mainの共有localhost Streamable HTTP listenerへ移行する。

現行runtime clientは同一HTTP requestの103 challengeを検証してからcredentialと操作本文を送る。調査対象のprovider native HTTP MCP設定には、この送信順序を実現するtransport hookを確認できていない。標準HTTP header認証への変更は、現行の事前本人確認と等価ではない。

利用者はローカル専用の接続であることを踏まえ、本人確認の簡素化を採用した。一方、正常なSessionの誤拒否、別Sessionや古いturnへの誤認を避ける識別・認可境界は維持する。

## 判断

- Mainのloopback listenerをMemory／CharacterとGlossaryで共有する。接続ごとのstdio helperやprovider process共有を代替方式にしない。既存tool schema、actor-relative target、application boundaryを利用し、DBへ直結しない。
- provider → HTTP MCPでは、現在のruntime owner、binding、logical turnに固定した推測不能な短命credentialを発行し、最初のrequestから認証headerへ送る。既存adapter secret、binding reference、turn capabilityをheaderへ流用しない。credentialはprocess memory内に限定し、prompt、通常log、履歴、artifact、永続provider設定へ保存しない。
- credentialのlookupは認証済みcontextの解決だけを担う。authorityの正本は既存binding registryとturn coordinatorとし、新しいgrant registry、署名方式、hash台帳、永続credential storeを作らない。認証後もexact owner、binding generation、grant、captured turnの有効性を照合する。
- initialize、tools/list、tools/call、GET／DELETEを含むrequestを認証する。MCP session IDはprotocol stateのselectorであって認可情報ではない。contextはactor／provider、application instance、Memory runtime generation、binding generation、captured turnへ固定し、callerのSession IDや「そのactorの現在のturn」へ付け替えない。MemoryとSession runtimeのgeneration一致は要求しない。
- 同じturnのretry／reconnectは有効なcontextを再利用できる。次turnは新credentialと新接続にし、古いprocessやMCP sessionへ新しい権限を配布しない。取消受付、turn終了、binding失効、Session削除、runtime reset、shutdownで該当contextを失効させる。古いhandleのcleanupは次turnを失効させない。非同期処理は受付時だけでなく既存の副作用境界でもcontextを照合し、確定済み副作用を取消成功として隠さない。
- loopbackへbindし、Host／remote addressを検証し、現行のbrowser Origin拒否を維持する。無認証経路や別instanceへのrebindを作らない。正常なSessionの再接続で識別が変わらないことと、stale／別actor／別instanceを副作用前に拒否することを別々に確認する。
- operator CLIとagent-bound CLI fallbackのauthority分離、既存runtime exchangeのchallenge、effect certainty、idempotencyを維持する。共有MCP ownerが既存fallback admissionのreporterを担い、tools/listの正常送出、operation開始時に捕捉したadmission、内側のruntime exchangeの実transport exceptionという条件を維持する。provider → HTTP MCPの切断やresponse lossだけではeligibleへ遷移させず、GlossaryへMemory fallbackを拡張しない。

## 影響と適用条件

相手の本人確認前にcredentialとMCP本文を送るため、shutdown後のport再利用や誤接続で別listenerへ届くリスクは残る。短命・turn限定credentialは権限と寿命を限定するが、誤送信自体を防がない。既存と同様、同一OS user上の攻撃的processからの秘匿は保証しない。この差を新HTTP入口に限って受け入れる。

providerごとの一時設定反映、credentialの非保存・redaction、旧managed stdio設定の切替は実接続で確認する。成立しないproviderを無認証や共通secretへ降格せず、機能を黙って無効にしない。利用者の設定や第三者MCPを自動削除しない。

本判断の採用は実装、全providerの接続成功、helper数・private memory・初期化時間の改善、統合、公開の完了を意味しない。

## 代案

同一接続の103検証をprovider native clientへ拡張する方式は、今回受け入れたローカル接続の保証に対して追加のprovider実装を要するため採用しない。全Session共通credentialやMCP session IDによる認可は、actorとturnの識別を維持できないため採用しない。Mainからapplication serviceへ直結して内側のruntime exchangeを除去する最適化は、CLI fallbackの障害対象を変えるため本判断に含めない。

## 関連判断

- [ADR 021: Agent runtime binding](021-agent-runtime-binding-authority-boundary.md)
- [ADR 023: 複数instanceのruntime discovery](023-multi-instance-runtime-discovery.md)
- [ADR 024: Provider共通Memory MCP](024-provider-common-memory-mcp-boundary.md)
