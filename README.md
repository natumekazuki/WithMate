# WithMate

WithMate は、Codex と GitHub Copilot の coding agent を、キャラクターと一緒に使う Electron デスクトップアプリです。ワークスペースを選んでセッションを開始し、チャット、コマンド実行の確認、ファイル参照、差分確認までを一つのアプリで扱います。

対応 runtime は Electron です。Vite の画面をブラウザーだけで利用する構成はサポートしていません。

## 主な機能

- Codex または GitHub Copilot を選んで coding session を作成、再開
- Character catalog からセッションごとのキャラクターを選択
- approval、sandbox、model、depth など、provider が対応する実行オプションの変更
- Markdown、添付ファイル、`@path` 参照を使った作業チャット
- 実行中のコマンド、turn summary、監査ログの確認
- Workspace、Session Folder、Additional Directory のファイル参照
- Git の作業差分とcommit履歴の確認
- checkout単位のRepository Glossaryの表示と検索
- セッション、Character、Memory、model catalogなどのローカル永続化

providerごとの対応状況は[対応機能一覧](docs/design/coding-agent-capability-matrix.md)を参照してください。

## 画面構成

### Home Window

セッションとCharacterを管理する入口です。

- `Recent Sessions`から既存セッションを検索、再開
- `New Session`でtitle、workspace、provider、Characterを選択
- `Session Monitor`で開いているセッションの状態を確認
- `Characters`からCharacterの作成、編集を開始
- Settings Windowと独立したSession Monitor Windowを開く

### Session Window

coding agentと作業する中心画面です。

- チャットの送信、応答のstreaming表示、実行中turnのcancel
- approval、model、depthなどの実行オプションを変更
- `Latest Command`、Copilotのbackground tasks、usage情報を確認
- Audit Log、Terminal、session title変更、session削除へ移動
- File Explorer、Repository Glossary、File Preview、Git Diffを同じ作業面から利用

AgentとCompanionは同じchat layoutを使い、modeとprovider adapterで動作を切り替えます。

### File ExplorerとFile Preview

Session WindowのFile Explorerには次のタブがあります。

- `Files`: Workspace、Session Folder、許可済みAdditional Directoryのファイルを参照
- `Changes`: Gitの作業ツリー差分を表示
- `History`: repositoryのcommit履歴とcommit時点のファイル、差分を表示

ファイルは中央の作業面または独立したFile Preview Windowで開けます。テキスト、Markdown、JSON、JSONC、YAML、画像、SVGに対応し、バイナリファイルは内容を展開せずに表示します。Git差分はSplitとInlineを切り替えられます。

### Repository Glossary

Git checkoutの`.withmate/glossary.yaml`にある用語、別名、定義をSession Windowで表示、検索します。checkoutに用語集がない場合やschemaが不正な場合は、その状態をpane内に表示します。

### Character Editor Window

Characterのprofile、icon、theme、`character.md`、`character-notes.md`を編集します。セッションは開始時点のCharacter snapshotを使うため、あとからCharacterを編集しても既存セッションへ自動反映されません。

### Settings Window

次のapp共通設定を管理します。

- app起動、turn完了通知、Session Windowの表示動作
- default microcopy
- coding agent providerの有効化とprovider file settings
- Memory API、managed Skill、CLI shim、logのdiagnostics
- model catalogのimport、export
- Repository Glossaryの自動追加上限
- Memory file quotaと古いsessionの削除
- keyboard shortcut

### その他のWindow

- `Session Monitor Window`: 開いているセッションを常時手前で確認するcompact window
- `Diff Window`: 長い差分を広い領域で比較する独立window

画面ごとの責務は[Window Architecture](docs/design/window-architecture.md)、現在のUI仕様は[Desktop UI](docs/design/desktop-ui.md)を参照してください。

## ソースから起動する

### 必要な環境

- Node.js
- npm

依存関係をインストールします。

```bash
npm install
```

開発時は、最初のターミナルでVite rendererを起動します。

```bash
npm run dev
```

Viteが`http://localhost:4173`で起動したら、別のターミナルでElectronを起動します。

```bash
npm run electron:dev
```

`electron:dev`はElectron mainとMemory CLIをbuildしてから、開発用Electronを起動します。

## 開発と検証

### 型チェック

```bash
npm run typecheck
```

### テスト

```bash
npm test
```

テストは`scripts/tests/*.test.ts`と`scripts/tests/*.test.tsx`をNode test runnerで実行します。

### 本番向けbuild

```bash
npm run build
```

renderer、Electron main、Memory CLIをbuildします。本番向けbuildとローカル起動をまとめて行う場合は、次を実行します。

```bash
npm run electron:start
```

### 分離したvisual check

Windowsで現在のWorktreeをbuildし、専用のuser dataでElectronを起動します。

```powershell
& .\scripts\start-withmate-visual-check.ps1
```

このスクリプトは`%APPDATA%\WithMate-visual-check`を使用します。安全に識別できる既存のvisual check processがある場合は差し替えますが、インストール版WithMateは停止しません。

## 配布物をbuildする

`electron-builder`で配布物を作成します。

```bash
# current platformの既定target
npm run dist

# Windows NSIS installer
npm run dist:win

# macOS DMG
npm run dist:mac

# unpacked directory
npm run dist:dir
```

macOS向けの実buildにはmacOS環境またはmacOS CI runnerが必要です。packagingの詳細は[Distribution Packaging](docs/design/distribution-packaging.md)を参照してください。

## ライセンスと利用上の注意

WithMateのソースコードは[ISC License](LICENSE)で提供します。

本ソフトウェアは現状有姿で提供されます。機能、セキュリティ、機密性、可用性、特定目的への適合性、および本ソフトウェアに含まれるか本ソフトウェアが生成または保存する内容の完全性や正確性を保証しません。

導入前に、ソースコード、設定、依存関係、同梱物、および接続先サービスを自身で確認してください。本ソフトウェアの利用、改変、配布、外部サービスへの接続、およびデータの取り扱いは、利用者自身の判断と責任で行ってください。

この節は利用上の注意をまとめたものです。ライセンス条件は[LICENSE](LICENSE)を参照してください。

## Repository構成

- `src/`: React renderer、UI state、Window API型
- `src-electron/`: Electron main、preload、IPC、永続化、provider連携
- `scripts/`: build、生成、migration、検証用script
- `scripts/tests/`: Node test runner用test
- `docs/design/`: 現行設計の正本とdomain detail
- `docs/adr/`: 長期的な設計判断
- `docs/plans/`: 複数sessionまたは高リスク作業のplan
- `build/`: icon、installer、CLIなどのpackaging入力

## 関連ドキュメント

- [Product Direction](docs/design/product-direction.md): プロダクトの優先順位と判断基準
- [Documentation Map](docs/design/documentation-map.md): 現行設計文書の分類と入口
- [Window Architecture](docs/design/window-architecture.md): Window間の責務とlifecycle
- [Desktop UI](docs/design/desktop-ui.md): 現在の画面構成と操作
- [Settings UI](docs/design/settings-ui.md): Settings Windowの責務
- [Coding Agent Capability Matrix](docs/design/coding-agent-capability-matrix.md): providerごとの対応機能
- [Provider Adapter](docs/design/provider-adapter.md): CodexとCopilotのadapter境界
- [Database Schema](docs/design/database-schema.md): SQLiteとfile storageの保存構造
- [Session Local Files](docs/design/session-local-files.md): Session Folderと添付ファイル
- [Manual Test Checklist](docs/manual-test-checklist.md): 実機確認項目
