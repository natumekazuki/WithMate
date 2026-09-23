# Coding Agent Capability Matrix

WithMateが現在のSession UIから利用できるprovider機能を示す。provider SDKの一般的な対応表ではなく、WithMateのadapterとUIに接続済みの範囲である。実行・認可の責務は[Provider Adapter](provider-adapter.md)を参照する。

| 機能 | Codex | GitHub Copilot | WithMateの境界 |
| --- | --- | --- | --- |
| turn実行・session再開 | 対応 | 対応 | 保存済みthread／session identityから再開する |
| 実行中の取消と状態表示 | 対応 | 対応 | Mainのrun stateを共通Session UIへ投影する |
| model・reasoning depth | 対応 | 対応 | 選択可能な値はproviderとcatalogに従う。Copilotでは非対応depthを渡さない |
| approval | policyを写像 | permission requestへ応答 | 共通表示からprovider固有の実行判断へ変換する |
| sandbox設定 | 対応 | UI設定なし | Codexの選択値をSDK runtime optionへ渡す |
| file・folder・画像の入力 | 対応 | 対応 | workspaceと許可済みAdditional Directoryの範囲でprovider固有のattachmentへ変換する |
| Skill | mentionへ変換 | directiveへ変換 | 選択済みSkillをprovider側の入力へ反映する |
| custom agent | UI選択なし | 対応 | Copilotのagent catalogをSession設定へ解決する |
| assistant textのstreaming | 対応 | 対応 | 確定結果と実行中投影を区別する |
| command・変更差分・監査 | 対応 | 対応 | 共通のoperation、Audit Log、Git差分表示へ投影する |
| app内の承認・elicitation | 承認callbackなし | 対応 | Copilotのpermissionとform／URL質問をpending UIで扱う |
| background task snapshot | UI表示なし | 対応 | CopilotのTasks tabに現在のsessionのsnapshotを表示する |
| usage・quota・context情報 | 取得可能な情報を表示 | 取得可能な情報を表示 | providerごとの取得可能性と更新契機を区別する |

表示の詳細は[Desktop UI](desktop-ui.md)、usageの投影と保存境界は[Provider Usage Telemetry](provider-usage-telemetry.md)を参照する。capabilityが変わる実装では、この表を同じ論理変更で更新する。
