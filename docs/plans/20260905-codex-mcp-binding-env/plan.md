# Issue 453: Codex STDIO MCPへのbinding転送

## 作業範囲

基点は`676db67f537d491078a53b10133e26b8524a36ec`。Issue 453のMemoryとGlossaryへのSession限定環境転送を修正する。後続のAgent autonomy機能、push、PR作成、mergeは対象外。

## Closure Plan

### MCP-BINDING-TRANSFER

- Accepted anchor: Issue 453の5変数転送、値の非永続化、background分離。ADR 024のactor-relative Memoryとcurrent turn capability、ADR 023のruntime owner選択。
- Owner: `provider-agent-runtime-binding.ts`の環境投影と`codex-adapter.ts`のclient生成。
- Siblings: MemoryとGlossary、foreground、unbound、background、turn更新、Session invalidation。
- Failure: initializeとtools/listだけ成功しoperationがbinding不足で拒否される。旧turnや別Sessionの環境を再利用する。
- Direct checks: SDK生成optionsの転送設定、環境とcache更新、MCP list_targetsのoperation結果、既存binding/turn失効test、typecheck。
- Review lens: process環境とSession/cacheの認可分離。
- Gate: ready。

### MCP-CONFIG-OWNERSHIP

- Accepted anchor: Issue 453のユーザーMCP設定保護とdisabled尊重。ADR 022の管理launcher完全照合と、別transport、args、env、cwd、timeout、tool filterをcollisionとする契約。
- Owner: 管理launcher検証とCodex MCP設定照合。実行時overrideとSettings登録の同じ照合境界を使う。
- Siblings: MemoryとGlossary。既存Settings登録のSession descriptorは従来の登録対象として維持する。
- Failure: 同名の第三者commandへbindingを転送する。disabledを解除する。検査した定義と実行する定義が変わる。設定検査errorへ設定値を露出する。
- Direct checks: missing/exact/manual allowlist/disabled/collisionの設定結果、検証済み定義の固定、設定非書込、SDK/CLIのoverride解釈。
- Review lens: 検査から起動までの転送先固定と既存設定の保護。
- Gate: ready。

## 検証記録

- 基点: 関連6 test fileの63件が成功。既存checkはCodexのMCP転送設定を検出していない。
- SDK: lockfileに従い導入した`@openai/codex-sdk`と同梱CLIは0.153.1。`config`はdotted leafへ展開し、`configOverrides`はraw TOML overrideを渡す。`env`指定時はSDKがprocess環境を自動継承しない。
- 公式仕様: https://learn.chatgpt.com/docs/extend/mcp?surface=cli の`env_vars`はCodex環境から転送する変数名を指定する。
- 実WithMate経由の新規Codex Session確認は、機械的checkと区別して完了時に記録する。

## 実装と直接検証の結果

- `CodexManagedMcpConfigService`が検証済みlauncherと既存設定を照合し、2 serverの`enabled`、`command`、`args`、`env_vars`を実行限定で固定する。Settings登録も同じ設定判定を使う。binding値は既存の環境投影だけから渡す。
- adapterの新規2回帰testは基点sourceで失敗し、修正sourceで成功した。
- 関連12 test fileの186件、`npm run typecheck`、`npm run build`が成功した。buildの既存chunk size warningは残る。生成済みCLI artifactに内容差分はない。
- Git modeのtest-value抽出はexit 0。新規または意味変更の10 recordを審査し、いずれもACCEPT。これはrecord内のclaimとobservableの整合判定であり、参照原文や実環境動作を単独で証明するものではない。
- 同梱Codex CLI 0.153.1と分離した設定directoryで、設定の実検査、overrideの解釈、無関係MCPのdisabled保持、設定fileの非変更を確認した。解釈済みallowlistをInMemoryTransport経由の両MCPへ投影し、実HTTP runtimeのMemory list_targets成功とGlossary primary checkoutを確認した。
- sibling sweepでは`getClient`、`getThread`、`invalidateSessionThread`、`invalidateAllSessionThreads`、`revokeProviderExecution`、`env_vars`を確認した。foreground/background、turn更新、Session破棄、Memory/Glossaryを対象とし、Copilotの既存launcher consumerも既存testで確認した。Session MCPの転送変数追加はIssueの対象外なので行わない。
- Full-review gateはrun。commit済み差分についてMCP-BINDING-TRANSFERとMCP-CONFIG-OWNERSHIPの認可分離と設定照合を独立reviewへ渡す。

## 検証の限界と残リスク

- 実WithMate UIから新規Codex Sessionを開始し、Codexが起動したSTDIO MCP child processで両operationを呼ぶ確認は未実施。機械的checkはCLI設定解釈、MCP SDK、HTTP runtimeを組み合わせた確認である。
- 同梱Codex 0.153.1はfile設定とinline-table overrideをmergeし、未指定fieldを残すことを追加のsynthetic設定で確認した。検査時に既存の`env`、cwd、timeout、tool filterは拒否するが、検査直後の外部変更はatomicに検出できない。`command`と`args`は固定される一方、その間に追加された`env`やcwdなどは起動に影響し得る。MCP設定の編集はSessionを止めて行う。
- 開発版と非Windowsは自動overrideの対象外。runbookの手動allowlist設定と新規Session開始が必要となる。
