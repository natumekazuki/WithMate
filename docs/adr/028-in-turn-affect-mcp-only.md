# ADR 028: Affect更新を通常turn内MCPへ統一する

## Status

Accepted

## Subsequent decisions

[ADR 029](029-cli-mcp-parity-context-binding.md)により、通常turn内AffectをMCP入口だけに限定する部分は現行運用の適用対象外とする。CLIも同じbinding、current turn、公開schemaとapplication serviceを利用する。専用post-turn評価を設けず、Agentが記録する意味のある変化だけを保存する判断は維持する。以下の本文は当時の判断として保持する。

## Context

通常turn内のAgentによるAffect MCPと、turn完了後の専用LLM評価が併存していた。Issue #879の2026-10-26追加決定では、Affect更新をMemoryと同じ通常turn内MCPへ統一した。Codex、Copilot、Claude、OpenCodeに共通の追加生成・専用queue・retry・復旧を廃止する。

## Decision

- 通常turnのAgentが、記録する意味のある感情変化に対して`character_affect.appraise`を使う。毎turnの必須呼出しや変化なしeventは要求しない。省略・失敗・取消を別LLM、補完turn、合成eventで埋めない。
- linked episodeは同じappraisalの`memoryEpisode`だけで保存し、standalone episodeだけを`character_memory.append_episode`へ送る。一般Memoryの更新も既存MCPを使い、turn後の自動抽出は行わない。
- 通常turnのterminal保存と成功判定はAffect専用enqueue・settlementに依存しない。Session本体のdurable queue、thread、partial result、interrupted処理は維持する。
- pre-turn context取得、prompt注入、取得時のafterglow projectionを維持する。MCPとapplication serviceの認証・authority、actor/provider/captured turn/tokenの束縛、version検証、idempotency、`effect: unknown`の照合契約は変えない。通常turn中に保存済みのevent・episodeは、後続の応答失敗や取消で巻き戻さない。
- Affect専用のtrigger、evaluator、候補管理、scheduler、retry、起動時回収、quarantine解除と、現役consumerのないbackground provider契約を削除する。Affect専用modelや有料fallbackを追加しない。
- 既存V6 schema更新のtransaction内で`character_affect_turn_settlements`を削除する。pending、候補、retry、実行中、quarantineを再開せず、旧本文・候補を消去する。再実行可能な`DROP TABLE IF EXISTS`を使い、旧constructorや回収処理を起動しない。これは評価成功として扱わない。
- 保存済みAffect event、関連episode、一般Memory、version・idempotency情報は保持する。旧候補の一部が保存済み、または保存結果不明でも候補を再適用せず、正本に保存されたものを維持する。

## 置換範囲と結果

[ADR 020](020-memory-affect-mcp-application-boundary.md)の必須post-turn appraisalと専用settlement・retry・回収、[ADR 024](024-provider-common-memory-mcp-boundary.md)のlifecycle/MCPの2つのevent producerを維持する判断を置換する。[ADR 021](021-agent-runtime-binding-authority-boundary.md)と[ADR 023](023-multi-instance-runtime-discovery.md)のAffect専用background／unbound clientに関する判断も当該clientの廃止に伴い適用対象外とする。MCP主体、認証・application境界、通常turnのbinding・runtime discoveryと保存契約は維持する。

専用評価の追加LLM呼出しと永続queueの運用負担をなくす一方、AgentがMCPを使わないturnではAffect eventを作らない。現行契約は[Memory / Affect MCP Runbook](../runbooks/memory-affect-mcp.md)、[V6 Memory Foundation](../design/v6-memory-foundation.md)、[Session Run Lifecycle](../design/session-run-lifecycle.md)、[Database Schema](../design/database-schema.md)を正本とする。
