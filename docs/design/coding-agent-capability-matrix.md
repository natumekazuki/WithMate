# Coding Agent Capability Matrix

WithMateが現在のSession UIから利用できるprovider機能を示す。provider APIの一般的な対応表ではなく、WithMateのadapterとUIに接続済みの範囲である。Codexは公式CLIのApp Server、CopilotとClaudeは公式SDK、OpenCodeは公式CLI／client `2.1.4`を使用する。実行・認可の責務は[Provider Adapter](provider-adapter.md)を参照する。

| 機能 | Codex | GitHub Copilot | Claude Agent | OpenCode | WithMateの境界 |
| --- | --- | --- | --- | --- | --- |
| turn実行・session再開 | 対応 | 対応 | 対応 | 対応 | 保存済みthread／session identityから再開する。Claude／OpenCodeは明示IDを使う |
| 実行中の取消と状態表示 | 対応 | 対応 | 対応 | 対応 | Mainのrun stateを共通Session UIへ投影する |
| model・reasoning depth | SDK一覧 | SDK一覧 | SDK一覧 | native一覧 | Model候補と任意のDepthは各SDKから取得し、Depthなしのmodelも扱う。一覧更新で選択値を変更しない。OpenCodeは実行時にnative model／variantの有効性も検証する |
| approval / reviewer | 3方針＋User / Auto Review | 3方針・User判断 | 5方針＋User / Auto Review（組合せ制約あり） | Provider Controlled／Auto Run・User判断 | WithMateの承認方針と判断担当をnative設定へ写像する。Claudeは全6 permission modeへ対応する。OpenCodeはproject永続許可を発行しない |
| speed | Standard / Fast | UI設定なし | Standard / Fast | UI設定なし | ClaudeのFastはmodel・利用資格・追加課金条件に依存する |
| sandbox設定 | 対応 | UI設定なし | UI設定なし | UI設定なし | Codexの選択値をApp Serverのsandbox policyへ渡す |
| file・folder・画像の入力 | 対応 | 対応 | file／folder、PNG／JPEG／GIF／WebP | file URIへ変換、native model能力で制限 | workspaceと許可済みAdditional Directoryの範囲でprovider固有の入力へ変換する |
| Skill | mentionへ変換 | directiveへ変換 | 選択pathをdirectiveへ変換 | 名前をdirectiveへ変換 | 選択済みSkillをprovider側の入力へ反映する。native Skill探索とは別 |
| custom agent | UI選択なし | 対応 | UI選択なし | UI選択なし | Copilotのagent catalogをSession設定へ解決する |
| assistant textのstreaming | 対応 | 対応 | 対応 | 対応 | 確定結果と実行中投影を区別する |
| command・操作結果・変更差分 | 対応 | 対応 | 対応 | 操作結果のみ、artifact差分なし | 共通のoperationTimeline、応答Details、Git差分表示へ投影する |
| app内の承認・elicitation | 承認・permissions・質問・MCP elicitationに対応 | 対応 | 承認・質問に対応 | 承認・form質問に対応 | 元requestとの対応を保持し、同一turnの要求を共通pending UIで直列処理する。OpenCodeの未対応fieldは拒否する |
| Memory・Affect MCP | 対応 | 対応 | 対応 | managed HTTP MCP | 通常turn内で既存application serviceを使う。Affectの専用post-turn評価、通常Memoryの背景抽出は行わない |
| 実行中の追加入力 | 対応 | 未対応 | 未対応 | 未対応 | Codexの現在turnへexpectedTurnId付きturn/steerを送る。terminal後・turn不一致では拒否する |
| background task snapshot | UI表示なし | 対応 | UI表示なし | UI表示なし | CopilotのTasks tabに現在のsessionのsnapshotを表示する |
| usage・quota・context情報 | turn usage、契約quotaの定期取得・Monitor／Action Dock表示 | 取得可能な情報を表示 | token／cache usage、契約quotaの定期取得・Monitor／Action Dock表示 | token／context、Go契約quotaの定期取得・Monitor／Action Dock表示 | 契約残量とtoken消費を混同しない。ClaudeのAPI換算額は実請求額として表示しない |

OpenCode列は実装の接続範囲を示す。Go実接続はWindows x64・CLI／client `2.1.4`で、両modelの`high`による通常turn、GLM-5.3の明示thread再開、Flashのstreaming中取消とowned process終了を確認している。Flashの通常turnからMemory追加・read-back、単独episode、即時Affect更新とlinked episodeの保存も確認している。`low / max`の生成、macOS／arm64の実接続はこの確認範囲に含まない。

表示の詳細は[Desktop UI](desktop-ui.md)、usageの投影と保存境界は[Provider Usage Telemetry](provider-usage-telemetry.md)を参照する。capabilityが変わる実装では、この表を同じ論理変更で更新する。
