# Coding Agent Capability Matrix

WithMateが現在のSession UIから利用できるprovider機能を示す。provider APIの一般的な対応表ではなく、WithMateのadapterとUIに接続済みの範囲である。Codexは公式CLIのApp Server、CopilotとClaudeは公式SDKを使用する。実行・認可の責務は[Provider Adapter](provider-adapter.md)を参照する。

| 機能 | Codex | GitHub Copilot | Claude Agent | WithMateの境界 |
| --- | --- | --- | --- | --- |
| turn実行・session再開 | 対応 | 対応 | 対応 | 保存済みthread／session identityから再開する。Claudeは明示IDでresumeする |
| 実行中の取消と状態表示 | 対応 | 対応 | 対応 | Mainのrun stateを共通Session UIへ投影する |
| model・reasoning depth | 対応 | 対応 | Opus 5.5、low／medium／high／xhigh／max | 選択可能な値はproviderとcatalogに従う。Copilotでは非対応depthを渡さない |
| approval | policyを写像 | permission requestへ応答 | Provider Controlledのみ | 共通表示からprovider固有の実行判断へ変換する |
| sandbox設定 | 対応 | UI設定なし | UI設定なし | Codexの選択値をApp Serverのsandbox policyへ渡す |
| file・folder・画像の入力 | 対応 | 対応 | file／folder、PNG／JPEG／GIF／WebP | workspaceと許可済みAdditional Directoryの範囲でprovider固有の入力へ変換する |
| Skill | mentionへ変換 | directiveへ変換 | 選択pathをdirectiveへ変換 | 選択済みSkillをprovider側の入力へ反映する。Claudeのnative Skill探索とは別 |
| custom agent | UI選択なし | 対応 | UI選択なし | Copilotのagent catalogをSession設定へ解決する |
| assistant textのstreaming | 対応 | 対応 | 対応 | 確定結果と実行中投影を区別する |
| command・変更差分・監査 | 対応 | 対応 | 対応 | 共通のoperation、Audit Log、Git差分表示へ投影する |
| app内の承認・elicitation | 承認・permissions・質問・MCP elicitationに対応 | 対応 | 承認・質問に対応 | Codexは元request IDとの対応を保持して回答し、同一turnの要求を共通pending UIで直列処理する |
| 実行中の追加入力 | 対応 | 未対応 | 未対応 | Codexの現在turnへexpectedTurnId付きturn/steerを送る。terminal後・turn不一致では拒否する |
| background task snapshot | UI表示なし | 対応 | UI表示なし | CopilotのTasks tabに現在のsessionのsnapshotを表示する |
| usage・quota・context情報 | 取得可能な情報を表示 | 取得可能な情報を表示 | token／cache usage、quotaは未対応 | 契約残量とtoken消費を混同しない。ClaudeのAPI換算額は実請求額として表示しない |

表示の詳細は[Desktop UI](desktop-ui.md)、usageの投影と保存境界は[Provider Usage Telemetry](provider-usage-telemetry.md)を参照する。capabilityが変わる実装では、この表を同じ論理変更で更新する。
