# WithMate

WithMateは、Codex、GitHub Copilot、Claude Agent、OpenCodeのcoding agentを、キャラクターと一緒に使うElectronデスクトップアプリです。ワークスペースを選んでセッションを開始し、チャット、コマンド実行の確認、ファイル参照、差分確認までを一つのアプリで扱います。

対応runtimeはElectronです。ブラウザー単体での利用はサポートしていません。

## 主な機能

- Codex、GitHub Copilot、Claude Agent、OpenCodeを選んでセッションを作成・再開
- セッションごとのCharacter選択と、Character定義・icon・themeの編集
- approval、sandbox、model、depthなど、providerが対応する実行オプションの変更
- Markdown、添付ファイル、`@path`参照を使ったチャットと、コマンド・応答Detailsの確認
- Workspace、Session Folder、Additional Directoryのファイル参照と、HTML・PDFなどのプレビュー
- Codexの`visualize`で指定されたHTML／PDFのチャット内表示
- Gitの作業差分・commit履歴の確認と、Repository Glossaryの表示・検索
- セッション、Character、Memory、SDKから取得したmodel候補などのローカル保存

Codexが既定のproviderです。Claude AgentとOpenCodeはSettingsで有効化した場合に利用できます。providerごとの対応状況は[対応機能一覧](docs/design/coding-agent-capability-matrix.md)を参照してください。

Model候補とDepthは各providerのSDK／native一覧から取得します。SessionのModelを開くと検索でき、候補更新は現在の選択や実行中の設定を変更しません。詳細は[Provider Model Discovery](docs/design/model-catalog.md)を参照してください。

Homeからセッションの作成・再開やCharacterの管理を行い、Session Windowで作業します。画面構成と操作は[Desktop UI](docs/design/desktop-ui.md)、機能別の使い方は[Feature Guides](docs/features/README.md)を参照してください。

## 利用上の注意

OpenCodeはPCのPATH上にある公式CLI `2.2.1`と同梱client `2.2.1`を使います。既存のnative DB・設定・API key／OAuth認証を、公式standalone相当の専用processから利用し、起動済みの共有serviceは変更・停止しません。service専用のmanaged環境変数は適用されないため、必要な認証はstandalone側またはWithMateの起動元環境へ設定してください。CLI版が異なる場合はDBを開かず停止します。新しい版で使用済みのDBをdowngradeしないでください。WithMate専用のGo key設定・認証UIはなく、WithMateにだけGo keyを登録していた場合は利用者自身でOpenCode側へ登録する必要があります。`opencode-go/...`、`opencode/...`、`openai/...`等のnative modelを同じOpenCode Sessionで扱いますが、一覧取得は認証成功の確認ではありません。利用前に自身の契約・設定・課金経路を確認してください。詳細と既存会話の継続条件は[modelと認証](docs/design/model-catalog.md#opencodeのmodelと認証)を参照してください。

Claude Agentは公式Claude Agent SDKに付属する未改変の実行物を使い、利用者自身がClaude CLIでログインした認証状態をSDKが利用します。WithMateは認証情報を読み取り・コピーせず、独自OAuthも提供しません。SDKが参照する環境変数・設定によって認証先や課金経路が変わり得るため、利用前に自身の契約・設定・課金経路を確認してください。認証失敗や利用枠不足を別の認証・モデル・providerへ自動切替しません。ClaudeのSDK transcriptはWithMateの会話履歴とは別にClaude側へ保存され、WithMateはそれを管理・削除しません。認証・実行の詳細は[Provider Adapter](docs/design/provider-adapter.md)を参照してください。

HTMLはアプリ権限から隔離して実行しますが、外部への通信を行う場合があります。利用条件・制約は[HTML Preview Isolation](docs/design/electron-window-runtime.md#html-preview-isolation)を参照してください。

## ソースから起動する

Node.jsとnpmが必要です。依存関係をインストールします。

```bash
npm install
```

最初のターミナルでVite rendererを起動します。

```bash
npm run dev
```

Viteが`http://localhost:4173`で起動したら、別のターミナルでElectronを起動します。

```bash
npm run electron:dev
```

`electron:dev`はElectron main、Memory／Glossary／Session Graph CLI、PDF readerをbuildしてから、開発用Electronを起動します。PDF readerの変更には専用buildが必要です。[開発時の更新方法](docs/design/window-architecture.md#pdf-readerの隔離境界)を参照してください。

## 開発と検証

| コマンド | 内容 |
| --- | --- |
| `npm run typecheck` | production・開発script・testの型検査と依存境界のcheck |
| `npm test` | test全体の実行 |
| `npm run build` | renderer、PDF reader、Electron main、Memory／Glossary／Session Graph CLIのbuild |
| `npm run electron:start` | 本番向けbuildとローカル起動 |

Windowsで作業branchのsmoke・目視確認を行う場合は、インストール版とデータを分離する[visual check手順](docs/runbooks/development-workflow.md#分離したvisual-check)を使用してください。testの絞り込み、shard、PowerShellの引数指定などは[Development Workflowの検証手順](docs/runbooks/development-workflow.md#検証)を参照してください。

## 配布物をbuildする

`electron-builder`で配布物を作成します。

| コマンド | 配布物 |
| --- | --- |
| `npm run dist` | current platformの既定target |
| `npm run dist:win` | Windows NSIS installer |
| `npm run dist:mac` | macOS DMG |
| `npm run dist:dir` | unpacked directory |

macOS向けの実buildにはmacOS環境またはmacOS CI runnerが必要です。packagingの詳細は[Distribution Packaging](docs/design/distribution-packaging.md)を参照してください。

## Repository構成

- `src/`: React renderer、UI state
- `src-shared/`: Main、preload、renderer、CLIで共有する契約・正規化・定数
- `src-electron/`: Electron main、preload、IPC、永続化、provider連携
- `src-cli/`: 配布物に含めるMemory／Glossary／Session Graph CLIの入力ソース
- `scripts/`: build、生成、migration、検証用script
- `tests/`: Node test runner用test
- `docs/`: 機能ガイド、現行設計、運用手順、ADR、リリースノート
- `build/`: icon、installer、CLIなどのpackaging入力

## 開発への参加

コード変更・検証・Git操作は[Development Workflow](docs/runbooks/development-workflow.md)に従ってください。課題・不具合・レビュー残件・作業計画はGitHub Issue／PR、対応予定はGitHub Milestoneで管理します。[課題の対応予定と完了運用](docs/runbooks/development-workflow.md#課題の対応予定とmilestone)を参照してください。

## ドキュメント

- [Feature Guides](docs/features/README.md): 利用者向けの機能別ガイド
- [Documentation Map](docs/design/documentation-map.md): 現行設計・運用文書の一覧と保存規則
- [ADR](docs/adr/): 設計判断の背景、代替案、採否と適用状態
- [Release Notes](docs/releases/README.md): versionごとの変更、互換性、検証結果

## ライセンスと利用上の注意

WithMateのソースコードは[ISC License](LICENSE)で提供します。

本ソフトウェアは現状有姿で提供されます。機能、セキュリティ、機密性、可用性、特定目的への適合性、および本ソフトウェアに含まれるか本ソフトウェアが生成または保存する内容の完全性や正確性を保証しません。

導入前に、ソースコード、設定、依存関係、同梱物、および接続先サービスを自身で確認してください。本ソフトウェアの利用、改変、配布、外部サービスへの接続、およびデータの取り扱いは、利用者自身の判断と責任で行ってください。

この節は利用上の注意をまとめたものです。ライセンス条件は[LICENSE](LICENSE)を参照してください。
