# Unresolved Issues

- 作成日: 2026-07-09
- GitHub source: <https://github.com/natumekazuki/WithMate/issues>
- Notion source: <https://app.notion.com/p/monochrome-memory/1969d4b6f262803db370fdfb463fb02a?v=1969d4b6f2628013adb9000c5828fa3f&source=copy_link>

## Collection Notes

- GitHub は `gh issue list --repo natumekazuki/WithMate --state open --limit 200` と GitHub connector で open issue を確認した。
- Notion は database fetch で schema と view filter を確認した。
- Notion の対象 view は `Status` が `未着手` または `進行中` の行を表示する設定だった。
- Notion `query_database_view` / `query_data_sources` は Business plan 以上が必要なため、この環境では失敗した。
- その後、ユーザー提供の Notion export zip から `Issue 1969d4b6f262803db370fdfb463fb02a.csv` を確認した。
- export CSV の未完了 view は 59 件で、内訳は `進行中` 10 件、`未着手` 49 件だった。

## Resolved Since Collection

この節は収集時点の外部Issue一覧から、repository内の実装と契約へ反映済みになった項目を示す。外部Issue自体のclose状態は主張しない。

| # | Title | Resolution |
| --- | --- | --- |
| [#77](https://github.com/natumekazuki/WithMate/issues/77) | セッション情報にリポジトリ名(フォルダ名)を追加したい | `docs/adr/007-session-display-and-local-repository-metadata.md`とSession persistence / API contractへ反映済み |

## GitHub Open Issues

| # | Title | Initial Bucket | Summary | Updated |
| --- | --- | --- | --- | --- |
| [#283](https://github.com/natumekazuki/WithMate/issues/283) | 設計: V7 persistence foundationで全永続化境界を再設計する | Persistence / Architecture | SQLite write / lock / main process block を根本から見直し、DB・object store・projection・worker boundary を再設計する。 | 2026-07-07 |
| [#268](https://github.com/natumekazuki/WithMate/issues/268) | Session送信後にrunning表示が残る事象を調査する | Session runtime / Investigation | provider 完了、session 保存、renderer 反映、liveRun 残存のどこで running が残るかログで切り分ける。 | 2026-07-03 |
| [#248](https://github.com/natumekazuki/WithMate/issues/248) | CodexAdapterをJson-RPCベースに切り替える | Provider | Codex adapter の接続方式を JSON-RPC ベースへ切り替える。 | 2026-06-29 |
| [#222](https://github.com/natumekazuki/WithMate/issues/222) | V7: Multi-Agent / Control Plane 設計メモ | Multi-agent / Architecture | WithMate を Agent から安全に操作できる control plane として設計する構想。 | 2026-06-24 |
| [#191](https://github.com/natumekazuki/WithMate/issues/191) | future(character): Character定義 authoring / pack import 支援を検討する | Character / Future | Character 定義 authoring や pack import 支援を future scope として検討する。 | 2026-06-15 |
| [#115](https://github.com/natumekazuki/WithMate/issues/115) | .continue ファイルをプロバイダーのフォルダに作成して継続実行 | Session workflow | provider session folder に `.continue` を置き、継続実行を UI から制御する。 | 2026-05-11 |
| [#114](https://github.com/natumekazuki/WithMate/issues/114) | 放牧 | Background execution | WSL2 隔離、JSON schedule、WithMate からの background execution view を検討する。 | 2026-05-08 |
| [#109](https://github.com/natumekazuki/WithMate/issues/109) | Copilotのツール呼び出しで失敗したらそこで終了する？ | Provider / Bug | Copilot tool call failure 後にレスポンスが返らなくなる挙動を調査する。 | 2026-05-07 |
| [#107](https://github.com/natumekazuki/WithMate/issues/107) | feat: Browser Use / Browser Preview の基盤を追加する | Browser / Future | Browser Preview、screenshot、console/network、visual comment、agent context artifact を追加する構想。 | 2026-05-05 |
| [#106](https://github.com/natumekazuki/WithMate/issues/106) | Codexでエラー発生して復帰してもエラーメッセージが残り続ける | Provider / UI Bug | transient reconnect error が復帰後も message 欄と LatestCommand に残る。 | 2026-05-03 |
| [#89](https://github.com/natumekazuki/WithMate/issues/89) | ChatGPTを開いてコードをコピペまたはファイル添付して直接チャット出来る画面が欲しい | Provider alternative | SDK token を使わず、ChatGPT を開いて直接 chat する画面を検討する。 | 2026-04-25 |
| [#74](https://github.com/natumekazuki/WithMate/issues/74) | 非同期指示機能 | Session workflow | session memo file を作り、同一 session 内の補助指示として使う。 | 2026-04-16 |
| [#70](https://github.com/natumekazuki/WithMate/issues/70) | cancel押してからフリーズする | Session runtime / Bug | cancel 処理中に画面が安定しなくなる。 | 2026-04-15 |
| [#64](https://github.com/natumekazuki/WithMate/issues/64) | Tasksが完了しても消えてない？ | Copilot tasks / Bug | Copilot Tasks が完了後も残る、または main 完了後も running 表示になる。 | 2026-04-14 |
| [#58](https://github.com/natumekazuki/WithMate/issues/58) | Tauriへの移行検討 | Platform | Electron が重いため Tauri 移行を検討する。 | 2026-04-13 |
| [#57](https://github.com/natumekazuki/WithMate/issues/57) | セッションでユーザーメッセージの枠はメッセージに合わせたい | Session UI | user message bubble の幅を内容に合わせる。 | 2026-04-09 |
| [#52](https://github.com/natumekazuki/WithMate/issues/52) | 実行中にメッセージを追加で投げたい | Session workflow | 実行中に追加メッセージを送る別ボタンを追加する。 | 2026-04-08 |
| [#46](https://github.com/natumekazuki/WithMate/issues/46) | Workspaceの非指定起動 | Launch workflow | 固定 directory 配下に UUID directory を作って workspace 未指定で session 起動する。 | 2026-04-06 |
| [#45](https://github.com/natumekazuki/WithMate/issues/45) | モデルリスト取得 | Provider / Model catalog | Copilot の model list を取得する。 | 2026-04-06 |
| [#42](https://github.com/natumekazuki/WithMate/issues/42) | ファイル変更のDiff機能拡張 | Diff / Artifact | diff の変更前後コピー、復元、別ファイル保存を追加する。 | 2026-04-04 |
| [#29](https://github.com/natumekazuki/WithMate/issues/29) | マルチエージェント化 | Multi-agent / Future | WithMate 内部の agent 呼び出しを MCP 化する案。 | 2026-04-27 |
| [#10](https://github.com/natumekazuki/WithMate/issues/10) | GitHubCopilotSDKのカスタムスラッシュコマンド | Provider / Copilot | Copilot SDK custom slash command の活用を検討する。 | 2026-06-16 |

## Notion CSV Export Unresolved Issues

以下は Notion export の未完了 view CSV を正本として整理した一覧。

| ID | Status | Priority | Tag | Project | Title | Updated |
| --- | --- | --- | --- | --- | --- | --- |
| ISSUE-181 | 未着手 |  | Feature | WithMate | [[V9] SessionをCLIから操作できるようにする](https://app.notion.com/p/3969d4b6f262808db68be9096c71e980) | 2026年7月7日 9:25 |
| ISSUE-111 | 未着手 |  | Feature | WithMate | [[V8] Context Scout プリセットロールを追加する](https://app.notion.com/p/37f9d4b6f26280709868c4fb2952e51d) | 2026年7月7日 9:06 |
| ISSUE-185 | 未着手 |  | Feature | WithMate | [AuditLogも整理する](https://app.notion.com/p/3969d4b6f26280cf8540fc993d072be9) | 2026年7月7日 16:58 |
| ISSUE-184 | 未着手 |  | Feature | WithMate | [CompanionModeを削除](https://app.notion.com/p/3969d4b6f2628040ae6dc0057c27cc79) | 2026年7月7日 15:39 |
| ISSUE-183 | 未着手 |  | Feature | WithMate | [FileChangeのDiffを取るのをやめる](https://app.notion.com/p/3969d4b6f262807f9f32eb34ec84723b) | 2026年7月7日 15:38 |
| ISSUE-162 | 未着手 |  | Feature | WithMate | [Modelの編集画面欲しい](https://app.notion.com/p/3909d4b6f26280318de0e9eeef711728) | 2026年7月1日 10:43 |
| ISSUE-103 | 未着手 |  | Feature | WithMate | [Auxiliary使用中はmainを使えないし、同時に1つしか立ち上げられない](https://app.notion.com/p/3799d4b6f2628095a86bdeae5932e5b4) | 2026年6月8日 9:55 |
| ISSUE-104 | 未着手 |  | Feature | WithMate | [Chatの複製機能が欲しい](https://app.notion.com/p/3799d4b6f262806f8e5fc100415de885) | 2026年6月8日 10:47 |
| ISSUE-147 | 未着手 |  | Feature | WithMate | [AGENTS.mdのMemorySkillの使用方針の書き方](https://app.notion.com/p/38e9d4b6f26280d79d85c24b790fbf90) | 2026年6月30日 9:52 |
| ISSUE-156 | 未着手 |  | Bug | WithMate | [Companionモードでベースブランチにマージした時にマージコミットが作成されてない](https://app.notion.com/p/38f9d4b6f262806daa5df84cdeff4f02) | 2026年6月30日 9:45 |
| ISSUE-152 | 未着手 |  | Feature | RelayGraph | [RelayGraph の link に依存理由を付与して CLI から取得できるようにする](https://app.notion.com/p/38e9d4b6f262806fb3d1d8a8eaab139b) | 2026年6月29日 17:46 |
| ISSUE-140 | 未着手 |  | Bug, UI | WithMate | [CompanionのMerge画面が1つのファイルに選択状態奪われる](https://app.notion.com/p/3889d4b6f2628098b8b0c6796a5b87d3) | 2026年6月23日 16:44 |
| ISSUE-139 | 未着手 |  | UI | WithMate | [CompanionのMerge画面が初期表示で真っ白](https://app.notion.com/p/3889d4b6f262808db673f8f418431287) | 2026年6月23日 16:41 |
| ISSUE-138 | 未着手 |  | Bug, UI | WithMate | [MonitorでCompanionが実行中にならない](https://app.notion.com/p/3889d4b6f262803f9b23d219b3f27261) | 2026年6月23日 16:28 |
| ISSUE-135 | 未着手 |  | UI | WithMate | [Discard Companion後もCompanionSessionのWindowが残る](https://app.notion.com/p/3829d4b6f262801bb68bcf4288f0db48) | 2026年6月17日 14:40 |
| ISSUE-134 | 未着手 |  | Bug, UI | WithMate | [MonitorにCompanionが2つ重複して出る](https://app.notion.com/p/3829d4b6f26280b9ac0bf453accdbc49) | 2026年6月17日 14:39 |
| ISSUE-95 | 未着手 |  | Bug | WithMate | [Cancelが出来ない](https://app.notion.com/p/36d9d4b6f26280e2b955efd0ca4bb42c) | 2026年6月17日 11:21 |
| ISSUE-131 | 未着手 |  | Bug | WithMate | [Companionで実行中に閉じようとすると警告なしで閉じる](https://app.notion.com/p/3829d4b6f2628084bfb2f88a32f99997) | 2026年6月17日 11:19 |
| ISSUE-124 | 未着手 |  | UI | WithMate | [Home右ペインのボタンの並び整理](https://app.notion.com/p/3809d4b6f262804e91acf21e3d3c7397) | 2026年6月15日 17:30 |
| ISSUE-122 | 未着手 |  | Feature, UI | WithMate | [DetailsのOperationも閉じられるようにしたい](https://app.notion.com/p/3809d4b6f262805a8cd9ca1f8f86fe8f) | 2026年6月15日 17:20 |
| ISSUE-120 | 未着手 |  | Feature | WithMate | [多分Goalとかは/で打てば使える](https://app.notion.com/p/3809d4b6f2628092ba50f2a0ffaf6c0e) | 2026年6月15日 16:26 |
| ISSUE-107 | 未着手 |  | Feature | WithMate | [Auxiliaryで既定の動作を定義出来るようにする](https://app.notion.com/p/37c9d4b6f26280f5a8eed9ae8692a837) | 2026年6月12日 7:15 |
| ISSUE-106 | 未着手 |  | Feature | WithMate | [Sessionごとで固定のプロンプト注入機能を追加](https://app.notion.com/p/37c9d4b6f26280f6b33ec07059f9ce0b) | 2026年6月12日 7:12 |
| ISSUE-90 | 未着手 |  | Feature | WithMate | [データが更新されたらエージェントが発火される](https://app.notion.com/p/36c9d4b6f262804396cfdcbed0f60f46) | 2026年6月12日 14:15 |
| ISSUE-93 | 未着手 |  | Feature, UI | WithMate | [Copilotのプレミアムリクエスト表示終了](https://app.notion.com/p/36d9d4b6f262804ab185fca499d656c1) | 2026年5月27日 11:24 |
| ISSUE-92 | 未着手 |  | Feature | WithMate | [プロバイダーごとに任意のプロンプトを注入できるようにする](https://app.notion.com/p/36c9d4b6f26280738aa9c5c25e8d92fe) | 2026年5月26日 20:26 |
| ISSUE-91 | 未着手 |  | Feature | WithMate | [タグ付きプッシュでリリースビルド](https://app.notion.com/p/36c9d4b6f2628063afe1ef676fd0acfe) | 2026年5月26日 17:59 |
| ISSUE-88 | 未着手 |  | Feature, UI | WithMate | [ファイルプレビュー機能欲しい？](https://app.notion.com/p/36c9d4b6f2628069ab2efa83dd4341dc) | 2026年5月26日 10:57 |
| ISSUE-75 | 未着手 |  |  | WithMate | [CodexのReasoningが全然出ない](https://app.notion.com/p/3699d4b6f2628026a4c1f2051c3e7c84) | 2026年5月24日 3:08 |
| ISSUE-50 | 未着手 |  | Feature | WithMate | [定期実行タスク機能](https://app.notion.com/p/3649d4b6f2628071ab65f17c2f775935) | 2026年5月18日 9:40 |
| ISSUE-21 | 未着手 |  |  | MonochromeMemory.Log.AzureTableStorage | [サーバーレスにバックグラウンドサービスが対応していない](https://app.notion.com/p/1ac9d4b6f26280939b1bdc6550770705) | 2025年3月5日 0:01 |
| ISSUE-23 | 未着手 |  |  | MonochromeMemory.Log.AzureTableStorage | [tableClientの作成をコンストラクタで行う](https://app.notion.com/p/1b39d4b6f26280b6b182fbec9c8717e4) | 2025年3月11日 17:37 |
| ISSUE-22 | 未着手 |  |  | MonochromeMemory.Log.AzureBlobStorage | [BlobStorageにAppendでログを書き込む処理作成](https://app.notion.com/p/1b39d4b6f26280d8a180fc50e16d6931) | 2025年3月11日 17:36 |
| ISSUE-20 | 未着手 |  |  | MonochromeMemory.Api | [ErrorDetailsKeyにBadRequest追加](https://app.notion.com/p/1a89d4b6f26280b793e4c91cfd577577) | 2025年2月28日 17:36 |
| ISSUE-19 | 未着手 |  |  | MonochromeMemory.Api | [Attributeの値を取れる処理](https://app.notion.com/p/1a89d4b6f26280c393f6eb41642e17cb) | 2025年2月28日 17:28 |
| ISSUE-7 | 未着手 |  |  | MonochromeMemory.Files.AzureFunctions | [ファイル操作API開発](https://app.notion.com/p/1989d4b6f262809b8ed7cd5f9fa82314) | 2025年2月28日 13:45 |
| ISSUE-16 | 未着手 |  |  |  | [BlobのファイルをZipするローカル実行限定のツール](https://app.notion.com/p/1a69d4b6f26280aba436c5b04e6e32d2) | 2025年2月26日 11:49 |
| ISSUE-10 | 未着手 |  |  | MonochromeMemory.Certification.DB | [MonochromeMemory.Certification.DBの設計](https://app.notion.com/p/1999d4b6f262807e9ddfe0504b25ab68) | 2025年2月13日 15:02 |
| ISSUE-9 | 未着手 |  |  | MonochromeMemory.Files.BlobStorage | [Blobのファイルを操作するライブラリの開発](https://app.notion.com/p/1989d4b6f26280979c28e72005b05a11) | 2025年2月12日 13:00 |
| ISSUE-8 | 未着手 |  |  | MonochromeMemory.Files.CosmosDB | [ファイルをCosmosDBにマッピングするライブラリの開発](https://app.notion.com/p/1989d4b6f26280e59d87e7c49cabd804) | 2025年2月12日 12:59 |
| ISSUE-3 | 未着手 |  |  | MonochromeMemory.RSA | [RSA暗号化の汎用ライブラリ開発](https://app.notion.com/p/1969d4b6f262802489bbe0a5c2fc4b29) | 2025年2月11日 15:51 |
| ISSUE-186 | 未着手 | Low | UI | WithMate | [Sendボタンを下に下げる](https://app.notion.com/p/3989d4b6f262802b9f6eca1beb072ff7) | 2026年7月9日 17:22 |
| ISSUE-179 | 未着手 | Low |  | WithMate | [AuditLogのBackendってもうないのでは？](https://app.notion.com/p/3959d4b6f2628075a777d396df1acf04) | 2026年7月6日 15:38 |
| ISSUE-176 | 未着手 | Low | Feature, UI | WithMate | [古いセッションの削除でDatePicker追加](https://app.notion.com/p/3959d4b6f262802c93fad9f395fc8c35) | 2026年7月6日 10:32 |
| ISSUE-171 | 未着手 | Low | Feature | WithMate | [自分をキャラだと宣言するときがある](https://app.notion.com/p/3929d4b6f26280299dcced6d588f289c) | 2026年7月3日 14:38 |
| ISSUE-182 | 未着手 | Medium | Feature | WithMate | [機能をそぎ落とす](https://app.notion.com/p/3969d4b6f26280179845e925d21ab3ff) | 2026年7月7日 15:38 |
| ISSUE-180 | 未着手 | Medium | Feature | WithMate | [WithMate Memory should support lifecycle metadata for expiring, stale, and reviewable entries](https://app.notion.com/p/3959d4b6f26280b9a139e6516ad7ce61) | 2026年7月6日 16:03 |
| ISSUE-178 | 未着手 | Medium | Feature | WithMate | [WithMate Memory CLI should support target inventory, entry listing, and safe cleanup workflows](https://app.notion.com/p/3959d4b6f26280f9b0cfcf16f0cc8c8d) | 2026年7月6日 14:57 |
| ISSUE-177 | 未着手 | Medium | Investigation | WithMate | [DB操作でロックされている？](https://app.notion.com/p/3959d4b6f26280919666f8933fb92a8d) | 2026年7月6日 13:23 |
| ISSUE-144 | 進行中 |  | UI | WithMate | [Memory ReviewがカードのUIで全画面化した時にUIが不自然](https://app.notion.com/p/38e9d4b6f2628088a4cfca9e1725128f) | 2026年7月5日 18:06 |
| ISSUE-160 | 進行中 |  | Feature | WithMate | [レスポンスの途中経過と最終的な返答を区別する](https://app.notion.com/p/3909d4b6f26280dca817f9f72834c80f) | 2026年7月5日 1:47 |
| ISSUE-163 | 進行中 |  | Feature | WithMate | [Memoryでファイルを持てるようにする](https://app.notion.com/p/3909d4b6f262804ba182f211793a0550) | 2026年7月4日 23:40 |
| ISSUE-68 | 進行中 |  | UI | WithMate | [マイクロコピーが馴れ馴れしい](https://app.notion.com/p/3679d4b6f26280c780afd3b9395524e2) | 2026年5月26日 13:58 |
| ISSUE-83 | 進行中 |  | Bug, UI | WithMate | [Companionでプロンプトとレスポンスの待機がすぐに出ない](https://app.notion.com/p/36b9d4b6f26280b0a9f8e631f6731202) | 2026年5月25日 19:54 |
| ISSUE-82 | 進行中 |  | Bug | WithMate | [AuxiliaryがAgentModeにしか対応してない](https://app.notion.com/p/36b9d4b6f26280ed9737e895a23af89a) | 2026年5月25日 19:54 |
| ISSUE-168 | 進行中 | Medium | Bug, Investigation | WithMate | [Sessionのメッセージ送信から完了までの処理を調査](https://app.notion.com/p/3929d4b6f2628063a8c4c2c5f9c7118e) | 2026年7月3日 21:48 |
| ISSUE-175 | 進行中 | High | Bug | WithMate | [Auxiliaryで実行中にAuditLogが元Sessionから切り離されてる](https://app.notion.com/p/3949d4b6f26280588e1ff66b2906f68f) | 2026年7月5日 17:57 |
| ISSUE-174 | 進行中 | High | Bug | WithMate | [＠で存在しないパスを入力した時にテキスト入力が出来なくなる](https://app.notion.com/p/3949d4b6f26280f681c6df597e762e54) | 2026年7月5日 13:55 |
| ISSUE-167 | 進行中 | High | Bug | WithMate | [文字入力が異常に重たくなる](https://app.notion.com/p/3929d4b6f26280bc9de7c66c79bc9020) | 2026年7月3日 21:12 |

## Superseded Search-Based Notion Notes

以下は export CSV を受け取る前に `search` で拾った候補である。現在は上の CSV export 一覧を正本として扱う。

| Title | Source | Observed Status / Priority | Initial Bucket | Note |
| --- | --- | --- | --- | --- |
| [Sendボタンを下に下げる](https://app.notion.com/p/3989d4b6f262802b9f6eca1beb072ff7?pvs=1) | Notion | 未確認 | Session UI | 2026-07-09 更新。Send button layout の UI 調整候補。 |
| [Sendボタンがテキストエリアの中に入ってる](https://app.notion.com/p/3949d4b6f26280858847e3910caf9146?pvs=1) | Notion | 未確認 | Session UI / Bug | Send button placement の不具合候補。 |
| [Auxiliaryで実行中にAuditLogが元Sessionから切り離されてる](https://app.notion.com/p/3949d4b6f26280588e1ff66b2906f68f?pvs=1) | Notion | 未確認 | Auxiliary / Audit | parent session audit owner の問題。 |
| [文字入力が異常に重たくなる](https://app.notion.com/p/3929d4b6f26280bc9de7c66c79bc9020?pvs=1) | Notion | 未確認 | Session composer / Performance | path reference resolution が疑われている。 |
| [Sessionのメッセージ送信から完了までの処理を調査](https://app.notion.com/p/3929d4b6f2628063a8c4c2c5f9c7118e?pvs=1) | Notion | 未確認 | Session runtime / Investigation | GitHub #268 と関連する可能性が高い。 |
| [Auxiliary実行中のMonitorが実行中にならない](https://app.notion.com/p/36b9d4b6f2628077a64ad851f7e5e967?pvs=1) | Notion | 未確認 | Auxiliary / Monitor | Auxiliary live state が monitor へ反映されない。 |
| [MonitorでCompanionが実行中にならない](https://app.notion.com/p/3889d4b6f262803f9b23d219b3f27261?pvs=1) | Notion | 未確認 | Companion / Monitor | Companion live state が monitor へ反映されない。 |
| [Companionで実行中に閉じようとすると警告なしで閉じる](https://app.notion.com/p/3829d4b6f2628084bfb2f88a32f99997?pvs=1) | Notion | 未確認 | Companion / Safety | 実行中 close guard の不足。 |
| [Auxiliary使用中はmainを使えないし、同時に1つしか立ち上げられない](https://app.notion.com/p/3799d4b6f2628095a86bdeae5932e5b4?pvs=1) | Notion | 未確認 | Auxiliary / Concurrency | main / auxiliary の並行実行制約。 |
| [AuditLog表示バグ](https://app.notion.com/p/38f9d4b6f2628062aadad0edef9cf6f4?pvs=1) | Notion | 未確認 | Audit / Bug | 実行中 turn の log は見えるが、turn 終了後に 0 件になる。 |
| [Session AuditLog が実行中は synthetic 1件だけ表示され、完了後に persisted log が表示されない](https://app.notion.com/p/38e9d4b6f26280aeaee7ca2392e7a809?pvs=1) | Notion | 未確認 | Audit / Bug | AuditLog 表示バグと関連する可能性あり。 |
| [WithMate Memory CLI の Windows/PowerShell `--json` 経路で検索系コマンドが失敗しやすい](https://app.notion.com/p/38e9d4b6f262801fad6cf864faca564e?pvs=1) | Notion | 未確認 | Memory CLI / Windows | PowerShell の JSON 引数経路の信頼性問題。 |
| [WithMate Memory should support lifecycle metadata for expiring, stale, and reviewable entries](https://app.notion.com/p/3959d4b6f26280b9a139e6516ad7ce61?pvs=1) | Notion | 未確認 | Memory / Lifecycle | Memory entry の expired / stale / reviewable metadata。 |
| [WithMate Memory CLI should support target inventory, entry listing, and safe cleanup workflows](https://app.notion.com/p/3959d4b6f26280f9b0cfcf16f0cc8c8d?pvs=1) | Notion | 未確認 | Memory CLI | list / inventory / cleanup workflow。 |
| [Memory CLI should support attached workspace repository project targets](https://app.notion.com/p/3919d4b6f26280a38f01cc68fc46ce88?pvs=1) | Notion | 未確認 | Memory CLI / Project target | attached workspace を project target として扱う。 |
| [Memory access を Skill 先行で統一する](https://app.notion.com/p/36b9d4b6f26280b78cddd87978bcad44?pvs=1) | Notion | snippet: proposed / P1 | Memory / Skill | AGENTS.md 方針と関連。 |
| [Memoryの自然文検索が弱い](https://app.notion.com/p/38e9d4b6f262805d8624ef9cf4d25c77?pvs=1) | Notion | 未確認 | Memory search | 自然文検索で関連 entry を見つけにくい。 |
| [MemoryのProject指定操作権限](https://app.notion.com/p/3929d4b6f262804da422e15c8225df66?pvs=1) | Notion | 未確認 | Memory permission | attach / allowed project 以外の操作制限。 |
| [Memory V6: Project/Character に紐づかない user-global Memory target を追加する](https://app.notion.com/p/38e9d4b6f26280c591c5f9572bacaf7f?pvs=1) | Notion | 未確認 | Memory / Scope | user-global target の追加。 |
| [MEMORY_ENTRY_KINDSのCLIコマンド追加](https://app.notion.com/p/38e9d4b6f26280f3a2e5e01c90f86ef3?pvs=1) | Notion | 未確認 | Memory CLI | entry kind 発見性向上。 |
| [AGENTS.mdのMemorySkillの使用方針の書き方](https://app.notion.com/p/38e9d4b6f26280d79d85c24b790fbf90?pvs=1) | Notion | 未確認 | Docs / Agent policy | MemorySkill usage policy。 |
| [WithMate MemorySkill should recall known failure patterns before repeating failed commands](https://app.notion.com/p/38f9d4b6f2628021b47ad0af67797d22?pvs=1) | Notion | 未確認 | Agent policy / Memory | 失敗コマンド再実行前の failure pattern recall。 |
| [キャラ編集画面のUI修正](https://app.notion.com/p/3809d4b6f262808e8d06cb6106488aff?pvs=1) | Notion | 未確認 | Character UI | editor layout に未使用領域が出る。 |
| [future / V8 Context Scout プリセットロールを追加する](https://app.notion.com/p/37f9d4b6f26280709868c4fb2952e51d?pvs=1) | Notion | 未確認 | Multi-agent / Future | Context Scout role の設計候補。 |
| [RelayGraph: Git 管理下でのリソーストレーサビリティ設計](https://app.notion.com/p/36b9d4b6f26280038493e3f69d35ddc9?pvs=1) | Notion | snippet: active | Tooling / Traceability | repo resource traceability。WithMate 本体に入れるかは要判断。 |
| [表示中の画像全部を再配置して挿入出来るか探索するアルゴリズムの検討](https://app.notion.com/p/37f9d4b6f2628013b307e5f9d355fbbc?pvs=1) | Notion | 未確認 | Future / Algorithm | 画像配置アルゴリズム検討。 |
| [htmlファイル等、V4移行に伴う未使用資源の整理](https://app.notion.com/p/3649d4b6f262807ca70dee9ff3950344?pvs=1) | Notion | 未確認 | Cleanup | 旧資源整理。今回 `old/` 退避で再分類対象。 |

## Legacy Notion Candidates From Search Snippets

次の候補は検索 snippet 上で `Status: Draft` などの旧形式が見えている。現行 DB の Status と一致するかは未確認。

| Title | Source | Snippet Status / Priority | Initial Bucket |
| --- | --- | --- | --- |
| [MateTalk の返信メッセージに Mate アイコンが反映されない](https://app.notion.com/p/3609d4b6f26280aa8361f59fe6c52736?pvs=1) | Notion | Draft / P1 | Character / UI |
| [Mate アイコンが相対 path のまま renderer に渡り反映されない](https://app.notion.com/p/3609d4b6f262803a91f6cec9db84b9f6?pvs=1) | Notion | Draft / P1 | Character / UI |
| [MateTalk の自己定義発話が `core` ではなく `bond` / `work-style` に落ちやすい](https://app.notion.com/p/3609d4b6f262808494c4ee0a131052fd?pvs=1) | Notion | Draft / P1 | Character / Memory |
| [Mate Profile section の責務が曖昧で `core` / `bond` / `work-style` / `notes` の効き先がずれる](https://app.notion.com/p/3609d4b6f26280fa9da6ca4b3bc4ccd9?pvs=1) | Notion | Draft / P1 | Character / Data model |
| [Provider instruction sync が profile file 参照だけで、人格・振る舞い定義が provider に十分伝わらない](https://app.notion.com/p/3609d4b6f26280d9ab5dc0e764e89d2d?pvs=1) | Notion | Draft / P1 | Prompt / Provider |
| [Mate Growth Settings の `memoryCandidateMode` が runtime で効いていない](https://app.notion.com/p/3609d4b6f2628054bf04cdd629aa63b6?pvs=1) | Notion | Draft / P1 | Settings / Runtime |
| [Mate Growth Settings の Growth Model Priority UI を purpose-scoped / catalog-aware にする](https://app.notion.com/p/3609d4b6f262809fabcddd4868419658?pvs=1) | Notion | Draft / P1 | Settings / Model catalog |
| [4.0 runtime の DB 正本を `withmate-v4.db` に揃える](https://app.notion.com/p/3609d4b6f26280b3b02ddd66bdcc318f?pvs=1) | Notion | Draft / P1 | Persistence |
| [legacy DB に v4 schema を無条件注入しない](https://app.notion.com/p/3609d4b6f262800dbcbbdca2dca5ce40?pvs=1) | Notion | Draft / P1 | Persistence / Data integrity |
| [DB 世代を判定できる schema metadata と診断面を追加する](https://app.notion.com/p/3609d4b6f262802a8e3fdc8e1925bc7e?pvs=1) | Notion | Draft / P1 | Persistence / Diagnostics |
| [保存構造の current docs と regression test を runtime に揃える](https://app.notion.com/p/3609d4b6f262801896a1fe5d438dc514?pvs=1) | Notion | Draft / P1 | Docs / Tests |
| [Windows 開発環境で Copilot CLI が `.cmd` fallback に落ちて `spawn EINVAL` になる](https://app.notion.com/p/3609d4b6f26280d58461f191d1cb?pvs=1) | Notion | Draft / P1 | Provider / Windows |
| [v3 以前から v4 への明示的 upgrade / import パスを定義する](https://app.notion.com/p/3609d4b6f26280bc8475d4f2f4bb07dc?pvs=1) | Notion | Draft / P2 | Persistence / Migration |

## Recommended First Triage

1. `Persistence / Architecture`: GitHub #283 を新バージョンの最初の design task にする。
2. `Session runtime`: GitHub #268、#70、Notion running / AuditLog 系を統合する。
3. `Provider`: GitHub #248、#109、#106、#45、#10 を adapter contract task にまとめる。
4. `Character`: Character runtime は残し、authoring / MateTalk legacy は初期版から外すか検討する。
5. `Memory`: V6 をそのまま移植せず、scope / permission / lifecycle / CLI / object store を再設計する。
