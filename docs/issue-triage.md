# Issue Triage

- 作成日: 2026-07-09
- 目的: `docs/unresolved-issues.md` の GitHub / Notion 未完了 Issue を、新バージョンへ引き継ぐか捨てるか判断する
- 正本 Issue 一覧: `docs/unresolved-issues.md`

## Decision Legend

| Decision | Meaning |
| --- | --- |
| Carry | 新バージョンの backlog / design / implementation task へ引き継ぐ |
| Drop | 新バージョンには引き継がない |
| Merge | 別 Issue / task に統合して扱う |
| Done | 新バージョンのsource、executable contract、必要なADRへ反映済み |
| Defer | 初期版では扱わず、将来候補として残す |
| Unknown | 追加確認が必要 |

## GitHub Issues

| Source | Title | Decision | Reason / Merge Target |
| --- | --- | --- | --- |
| GitHub [#283](https://github.com/natumekazuki/WithMate/issues/283) | 設計: V7 persistence foundationで全永続化境界を再設計する | Carry | 新バージョンの persistence foundation と clean install 前提 bootstrap の土台として引き継ぐ。 |
| GitHub [#268](https://github.com/natumekazuki/WithMate/issues/268) | Session送信後にrunning表示が残る事象を調査する | Merge | 旧実装の個別調査は持ち込まず、新 Session runtime の lifecycle / live state 設計と受け入れ条件へ統合する。 |
| GitHub [#248](https://github.com/natumekazuki/WithMate/issues/248) | CodexAdapterをJson-RPCベースに切り替える | Carry | Codex provider adapter の JSON-RPC / app server 境界への切り替えタスクとして引き継ぐ。 |
| GitHub [#222](https://github.com/natumekazuki/WithMate/issues/222) | V7: Multi-Agent / Control Plane 設計メモ | Carry | 新バージョンで実装する複数エージェント / control plane の設計起点として引き継ぐ。方式は既存案をそのまま使わず再設計する。 |
| GitHub [#191](https://github.com/natumekazuki/WithMate/issues/191) | future(character): Character定義 authoring / pack import 支援を検討する | Drop | おおむね仕上がっているため、新バージョンの backlog には引き継がない。 |
| GitHub [#115](https://github.com/natumekazuki/WithMate/issues/115) | .continue ファイルをプロバイダーのフォルダに作成して継続実行 | Drop | 思いつきとして残っていたが作るほどではないため、新バージョンには引き継がない。 |
| GitHub [#114](https://github.com/natumekazuki/WithMate/issues/114) | 放牧 | Drop | background execution / scheduler 系は今回持ち込まないため、新バージョンには引き継がない。 |
| GitHub [#109](https://github.com/natumekazuki/WithMate/issues/109) | Copilotのツール呼び出しで失敗したらそこで終了する？ | Drop | 旧 Copilot 挙動は一旦引き継がない。新バージョンで再発した場合は新しい Issue を立てる。 |
| GitHub [#107](https://github.com/natumekazuki/WithMate/issues/107) | feat: Browser Use / Browser Preview の基盤を追加する | Drop | アプリで持つ機能ではないため、新バージョンには引き継がない。 |
| GitHub [#106](https://github.com/natumekazuki/WithMate/issues/106) | Codexでエラー発生して復帰してもエラーメッセージが残り続ける | Drop | 旧 UI のエラー表示残留は引き継がない。新バージョンで再発した場合は新しい Issue を立てる。 |
| GitHub [#89](https://github.com/natumekazuki/WithMate/issues/89) | ChatGPTを開いてコードをコピペまたはファイル添付して直接チャット出来る画面が欲しい | Drop | ChatGPT 直接利用画面は新アプリの機能として持たないため、引き継がない。 |
| GitHub [#77](https://github.com/natumekazuki/WithMate/issues/77) | セッション情報にリポジトリ名(フォルダ名)を追加したい | Done | `docs/adr/007-session-display-and-local-repository-metadata.md`のRepository metadataとSession projectionへ反映した。 |
| GitHub [#74](https://github.com/natumekazuki/WithMate/issues/74) | 非同期指示機能 | Carry | memo file 方式は引き継がない。JSON-RPC 方式で実行中に追加メッセージを投げられる場合に実装する。 |
| GitHub [#70](https://github.com/natumekazuki/WithMate/issues/70) | cancel押してからフリーズする | Drop | 旧実装の cancel フリーズ症状は引き継がない。新バージョンで再発した場合は新しい Issue を立てる。 |
| GitHub [#64](https://github.com/natumekazuki/WithMate/issues/64) | Tasksが完了しても消えてない？ | Drop | 旧 Copilot Tasks 表示の症状は引き継がない。新バージョンで再発した場合は新しい Issue を立てる。 |
| GitHub [#58](https://github.com/natumekazuki/WithMate/issues/58) | Tauriへの移行検討 | Drop | Tauri 移行検討は今回の新バージョンには引き継がない。 |
| GitHub [#57](https://github.com/natumekazuki/WithMate/issues/57) | セッションでユーザーメッセージの枠はメッセージに合わせたい | Drop | 旧 UI の細かな表示改善としては引き継がない。新 UI の message layout は実装時に改めて設計する。 |
| GitHub [#52](https://github.com/natumekazuki/WithMate/issues/52) | 実行中にメッセージを追加で投げたい | Merge | GitHub #74 と同じ追加メッセージ / asynchronous instruction として統合する。 |
| GitHub [#46](https://github.com/natumekazuki/WithMate/issues/46) | Workspaceの非指定起動 | Carry | workspace を指定せずに session を開始できる導線として新バージョンへ引き継ぐ。 |
| GitHub [#45](https://github.com/natumekazuki/WithMate/issues/45) | モデルリスト取得 | Merge | provider adapter / model catalog の仕様へ統合する。 |
| GitHub [#42](https://github.com/natumekazuki/WithMate/issues/42) | ファイル変更のDiff機能拡張 | Drop | Diff 機能拡張は新バージョンには引き継がない。 |
| GitHub [#29](https://github.com/natumekazuki/WithMate/issues/29) | マルチエージェント化 | Merge | GitHub #222 の Multi-Agent / Control Plane 設計へ統合する。 |
| GitHub [#10](https://github.com/natumekazuki/WithMate/issues/10) | GitHubCopilotSDKのカスタムスラッシュコマンド | Drop | Copilot SDK 固有の古い活用案として新バージョンには引き継がない。 |

## Notion Issues

| Source | Title | Decision | Reason / Merge Target |
| --- | --- | --- | --- |
| Notion ISSUE-181 | [V9] SessionをCLIから操作できるようにする | Merge | 基本操作を CLI でも行えるようにし、Skill として各エージェントに展開できる control plane / WithMateCLI session operation へ統合する。 |
| Notion ISSUE-111 | [V8] Context Scout プリセットロールを追加する | Carry | 扱いは未確定だが、他 Issue へ統合せず単独の検討枠として残す。 |
| Notion ISSUE-185 | AuditLogも整理する | Merge | AuditLog / structured logs / CLI operation の設計へ統合する。 |
| Notion ISSUE-184 | CompanionModeを削除 | Drop | 新バージョンでは CompanionMode を持たないため、旧実装の削除 Issue としては引き継がない。 |
| Notion ISSUE-183 | FileChangeのDiffを取るのをやめる | Drop | FileChange / Diff 周りは新バージョンには引き継がない。 |
| Notion ISSUE-162 | Modelの編集画面欲しい | Drop | Model 編集画面の要望としては新バージョンには引き継がない。 |
| Notion ISSUE-103 | Auxiliary使用中はmainを使えないし、同時に1つしか立ち上げられない | Merge | Auxiliary session / session runtime の同時実行・排他設計へ統合する。 |
| Notion ISSUE-104 | Chatの複製機能が欲しい | Drop | Chat 複製機能は初期版には引き継がない。必要になった場合は新しい Issue を立てる。 |
| Notion ISSUE-147 | AGENTS.mdのMemorySkillの使用方針の書き方 | Drop | AGENTS.md / MemorySkill 方針はアプリ Issue としては引き継がない。 |
| Notion ISSUE-156 | Companionモードでベースブランチにマージした時にマージコミットが作成されてない | Drop | Companion mode の旧 merge 挙動バグとして新バージョンには引き継がない。 |
| Notion ISSUE-152 | RelayGraph の link に依存理由を付与して CLI から取得できるようにする | Drop | RelayGraph 側のタスクであり、WithMate の引き継ぎ対象ではない。 |
| Notion ISSUE-140 | CompanionのMerge画面が1つのファイルに選択状態奪われる | Drop | Companion mode の旧 Merge UI バグとして新バージョンには引き継がない。 |
| Notion ISSUE-139 | CompanionのMerge画面が初期表示で真っ白 | Drop | Companion mode の旧 Merge UI バグとして新バージョンには引き継がない。 |
| Notion ISSUE-138 | MonitorでCompanionが実行中にならない | Drop | Companion mode 固有の旧 Monitor 表示バグとして新バージョンには引き継がない。 |
| Notion ISSUE-135 | Discard Companion後もCompanionSessionのWindowが残る | Drop | Companion mode 固有の旧 Window lifecycle バグとして新バージョンには引き継がない。 |
| Notion ISSUE-134 | MonitorにCompanionが2つ重複して出る | Drop | Companion mode 固有の旧 Monitor 表示バグとして新バージョンには引き継がない。 |
| Notion ISSUE-95 | Cancelが出来ない | Drop | 旧 cancel バグとして新バージョンには引き継がない。再発した場合は新しい Issue を立てる。 |
| Notion ISSUE-131 | Companionで実行中に閉じようとすると警告なしで閉じる | Drop | Companion mode 固有の旧 close guard バグとして新バージョンには引き継がない。 |
| Notion ISSUE-124 | Home右ペインのボタンの並び整理 | Drop | 旧 Home UI の細かな表示改善としては引き継がない。新 Home の layout は実装時に改めて設計する。 |
| Notion ISSUE-122 | DetailsのOperationも閉じられるようにしたい | Drop | 旧 Details UI の細かな表示改善としては引き継がない。operation 表示は新バージョンの logs / CLI operation 設計で改めて扱う。 |
| Notion ISSUE-120 | 多分Goalとかは/で打てば使える | Drop | メモ寄りで具体的な実装 Issue としては引き継がない。Session 入力 UX は新バージョンで必要に応じて改めて設計する。 |
| Notion ISSUE-107 | Auxiliaryで既定の動作を定義出来るようにする | Carry | Auxiliary session の既定動作 / preset を検討する単独 Issue として新バージョンへ引き継ぐ。 |
| Notion ISSUE-106 | Sessionごとで固定のプロンプト注入機能を追加 | Carry | Session ごとの固定 prompt 注入機能として、Character runtime prompt / session preset との責務境界を含めて単独 Issue として引き継ぐ。 |
| Notion ISSUE-90 | データが更新されたらエージェントが発火される | Drop | event trigger / automation 系は今回の新バージョン初期範囲には持ち込まないため、引き継がない。 |
| Notion ISSUE-93 | Copilotのプレミアムリクエスト表示終了 | Drop | Copilot 固有の旧表示 / 運用 Issue として、新 provider adapter には引き継がない。 |
| Notion ISSUE-92 | プロバイダーごとに任意のプロンプトを注入できるようにする | Carry | provider ごとの prompt 注入機能として、adapter / instruction policy の責務境界を含めて単独 Issue として引き継ぐ。 |
| Notion ISSUE-91 | タグ付きプッシュでリリースビルド | Drop | release automation は今回の新バージョン初期範囲には持ち込まない。必要になった場合は新しい Issue を立てる。 |
| Notion ISSUE-88 | ファイルプレビュー機能欲しい？ | Drop | file preview / artifact viewing は今回の新バージョン初期範囲には持ち込まない。必要になった場合は新しい Issue を立てる。 |
| Notion ISSUE-75 | CodexのReasoningが全然出ない | Drop | 旧 Codex 表示バグとしては引き継がない。新 Codex adapter で必要になった場合は新しい表示要件として扱う。 |
| Notion ISSUE-50 | 定期実行タスク機能 | Drop | scheduler / automation 系は今回の新バージョン初期範囲には持ち込まないため、引き継がない。 |
| Notion ISSUE-21 | サーバーレスにバックグラウンドサービスが対応していない | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-23 | tableClientの作成をコンストラクタで行う | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-22 | BlobStorageにAppendでログを書き込む処理作成 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-20 | ErrorDetailsKeyにBadRequest追加 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-19 | Attributeの値を取れる処理 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-7 | ファイル操作API開発 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-16 | BlobのファイルをZipするローカル実行限定のツール | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-10 | MonochromeMemory.Certification.DBの設計 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-9 | Blobのファイルを操作するライブラリの開発 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-8 | ファイルをCosmosDBにマッピングするライブラリの開発 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-3 | RSA暗号化の汎用ライブラリ開発 | Drop | Project が WithMate ではないため、今回の WithMate 新バージョンには引き継がない。 |
| Notion ISSUE-186 | Sendボタンを下に下げる | Drop | 旧 Session UI の細かな配置調整としては引き継がない。新 Session composer layout は実装時に改めて設計する。 |
| Notion ISSUE-179 | AuditLogのBackendってもうないのでは？ | Drop | 旧 Backend 前提の確認 Issue としては引き継がない。AuditLog は新バージョンの structured logs / CLI operation 設計で改めて扱う。 |
| Notion ISSUE-176 | 古いセッションの削除でDatePicker追加 | Drop | 旧 session cleanup UI の細かな改善としては引き継がない。Home / session management は新バージョンで必要に応じて改めて設計する。 |
| Notion ISSUE-171 | 自分をキャラだと宣言するときがある | Merge | Character runtime prompt / response policy の受け入れ条件へ統合する。 |
| Notion ISSUE-182 | 機能をそぎ落とす | Drop | 今回の zero-base scope 整理で目的は吸収済みのため、単独 Issue としては引き継がない。 |
| Notion ISSUE-180 | WithMate Memory should support lifecycle metadata for expiring, stale, and reviewable entries | Merge | Memory / WithMateCLI design の metadata / lifecycle requirements へ統合する。 |
| Notion ISSUE-178 | WithMate Memory CLI should support target inventory, entry listing, and safe cleanup workflows | Merge | Memory / WithMateCLI design の target inventory / entry listing / safe cleanup requirements へ統合する。 |
| Notion ISSUE-177 | DB操作でロックされている？ | Drop | 旧 persistence / DB 実装の調査 Issue としては引き継がない。新 persistence foundation で必要になった場合は新しい受け入れ条件として扱う。 |
| Notion ISSUE-144 | Memory ReviewがカードのUIで全画面化した時にUIが不自然 | Drop | 旧 Memory Review UI の細かな見た目改善としては引き継がない。Memory management UI は必要になった場合に改めて検討する。 |
| Notion ISSUE-160 | レスポンスの途中経過と最終的な返答を区別する | Merge | Session runtime / streaming / final response model の要件へ統合する。 |
| Notion ISSUE-163 | Memoryでファイルを持てるようにする | Drop | 旧 V6 では実装済みのため、新バージョンの未完 Issue としては引き継がない。必要な CLI 整理は Memory / WithMateCLI design へ吸収する。 |
| Notion ISSUE-68 | マイクロコピーが馴れ馴れしい | Drop | 旧 UI 文言のトーン調整としては引き継がない。新バージョンの文言設計は実装時に改めて扱う。 |
| Notion ISSUE-83 | Companionでプロンプトとレスポンスの待機がすぐに出ない | Drop | Companion mode 固有の旧 UI / runtime 表示バグとして新バージョンには引き継がない。 |
| Notion ISSUE-82 | AuxiliaryがAgentModeにしか対応してない | Drop | 旧 Auxiliary の mode 制限バグとしては引き継がない。新バージョンの Auxiliary 対応範囲は実装時に改めて設計する。 |
| Notion ISSUE-168 | Sessionのメッセージ送信から完了までの処理を調査 | Drop | 旧 Session runtime の調査 Issue としては引き継がない。新バージョンの session lifecycle は実装時に改めて設計する。 |
| Notion ISSUE-175 | Auxiliaryで実行中にAuditLogが元Sessionから切り離されてる | Drop | 旧 Auxiliary / AuditLog の接続バグとしては引き継がない。新バージョンの log correlation は実装時に改めて設計する。 |
| Notion ISSUE-174 | ＠で存在しないパスを入力した時にテキスト入力が出来なくなる | Drop | 旧 Session composer / mention 入力バグとしては引き継がない。新バージョンの composer input は実装時に改めて設計する。 |
| Notion ISSUE-167 | 文字入力が異常に重たくなる | Drop | 旧 Session composer / input performance バグとしては引き継がない。新バージョンの入力性能は実装時に改めて確認する。 |
