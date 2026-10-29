# ADR 029: CLIとMCPの公開契約を揃え、必要な文脈だけをbindingする

## Status

Accepted

## Context

Issue #905はWithMateの全公開操作についてCLIとMCPの双方向対応を要求する。入口ごとのoperator／Session区分では、同じ操作に異なる入力と権限が残る。一方、一般Memoryや稼働診断にCharacter文脈を要求しても操作対象の解決には寄与しない。ユーザーは、既存runtime認証を維持しつつ、Session／Characterを必要とする操作だけbinding必須とする整理を採用した。

## Decision

- CLIとMCPは公開操作、入力の意味・default、結果、scope、権限、副作用、errorを共有する。入口は共通schema／runtime clientから既存application serviceへ接続し、業務処理や保存の正本を複製しない。
- ローカルruntime認証とexact owner選択を維持する。bindingはその上で現在のSession／Character、許可範囲、記録者を解決する文脈であり、無認証の代替経路は作らない。
- Character context、Affect、Character所有Memory、Character一覧とSession Graphはbinding必須とする。一般MemoryのUser／Projectは明示target、Glossaryは明示repositoryでbindingなしに利用できる。稼働情報、metrics、容量・件数の集計にもbindingを要求しない。
- bindingを指定した操作は現在のbindingと許可scopeを検証する。無効bindingを無視してunboundへ降格しない。複数対象にbinding必須対象が含まれる場合は要求全体にbindingを要求し、対象を黙って除外・置換しない。
- 本文・個別記録のscopeと全体診断集計を区別する。bindingなしの容量詳細は一般Memoryに限定し、Character所有の個別記録へアクセスさせない。新しいSession別集計基盤は設けない。
- bound mutationのcurrent turn、明示的なユーザー指示とreasonを必要とするAffect correct/reset、非上書き、CAS、idempotency、effect certaintyを入口共通で維持する。operator専用MCPモードは導入しない。
- 通常CLIはMCP障害を利用条件としない。明示的な`--fallback-from mcp`による既存再試行では、serverのadmissionと同一request／idempotency条件を維持する。通常CLIへ自動切替する救済は追加しない。
- 機能変更では同じ論理変更で両入口、配布物、help/schema、現行文書、正常系・失敗系の実呼出し検証を揃える。

## 置換範囲

ADR 020・021・024・027のCLI専用operator権限、一般Memoryの一律binding必須、通常CLIをMCP障害時だけに限る判断を置換する。ADR 022のCLI／MCPに対するSession-bound repository指定だけの制限を置換し、rendererのSession scopeは変えない。ADR 028の通常turn内AffectをMCP入口だけに限定する部分を置換し、専用post-turn評価を設けない判断は維持する。各ADRの本文は当時の判断として保持する。

runtime credential、binding registry、generation、grant、captured turn、共有HTTP MCPの接続認証、application boundary、保存済みデータとmutationの整合契約は維持する。旧CLI explicit identity入力の互換経路は設けず、両入口の公開schemaへ統一する。

現行の操作契約は[Memory／Affect](../runbooks/memory-affect-mcp.md)、[Glossary](../runbooks/repository-glossary.md)、[Session Graph](../design/session-graph.md)、継続的な変更規約は[Development Workflow](../runbooks/development-workflow.md)を正本とする。

## Alternatives

全操作へSession bindingを要求する案は、文脈を使わない操作にも制約を増やすため採用しない。CLI operatorと明示operator MCPを追加する案も、入口の権限modeと認可検証を増やすため採用しない。Characterをrequest文字列だけで選ぶ案は、現在のactor scopeを失うため採用しない。
