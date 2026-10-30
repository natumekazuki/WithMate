# Documentation Map

現在の利用・開発・保守に必要な文書と、設計判断・リリースの履歴への入口です。現行仕様は一般文書で説明し、過去のADRをたどらないと現在の仕様が分からない構成にはしません。

## 文書の保存区分

- 一般文書は、対象branchの現行実装・設定・呼び出し経路について正しく、現在の利用・開発・保守に必要な情報だけを残します。現在有効な開発規則、互換性・データ保護契約、サポート中の移行・復旧手順は維持します。旧仕様、未実装の構想、作業計画・記録は、新しさ・進行中・採用済み・参照の有無を理由に保存しません。
- 設計・作業文書の履歴保持を認める例外はADRです。背景、代替案、採否、結果、置換関係を保持でき、古いことや現行実装との違いだけを理由に削除・上書きしません。決定の記録と現在の適用状態は区別します。
- リリースノートと索引は、ADRとは別枠でrepository内に恒久保存します。当時の変更内容・互換性・検証結果を現在の仕様へ書き換えません。

それ以外の過去情報はGit履歴、課題・不具合・review残件・作業計画はGitHub Issue／PR、一時的な棚卸し・検証記録はSessionFolder等のrepository外で扱います。追跡が必要な未解決事項だけを対応するIssue／PRへ集約し、対応先がなければ追跡先未確定として依頼元へ報告します。不要な一般文書をArchive、移転案内、完了サマリーとして残したり、ADR・リリースノートへ詰め替えたりしません。

仕様・実装を変更する時は、対応する一般文書の現行化と不要情報の削除、必要なADRの適用状態・置換関係の更新を同じ論理変更で行います。元の作業文書や旧正本は削除します。ADR・リリースノートに必要な当時の資料・画像への参照は実在する適切な版へ固定し、参照されているだけの一般文書や専用assetsは残しません。リリースノート固有の規則は[保存と参照](../releases/README.md#保存と参照)を参照してください。

## 現在の利用・運用

| 文書 | 内容 |
| --- | --- |
| [README](../../README.md) | 製品概要、主要機能、起動・検証・buildの基本手順と文書への入口 |
| [Feature Guides](../features/README.md) | 利用者向けの機能別ガイド |
| [Memory / Affect MCP Runbook](../runbooks/memory-affect-mcp.md) | Memory / Affect MCPの運用・診断 |
| [Repository Glossary Runbook](../runbooks/repository-glossary.md) | 用語集の運用・診断 |

## 設計・実装の入口

### 製品・Window・UI

| 文書 | 内容 |
| --- | --- |
| [Product Direction](product-direction.md) | 製品の目的と判断基準 |
| [UI Design Guidelines](ui-design-guidelines.md) | 画面横断のデザイン原則と共通パターン |
| [Window Architecture](window-architecture.md) | Windowの責務とmode |
| [Desktop UI](desktop-ui.md) | 画面構成と操作 |
| [Settings UI](settings-ui.md) | Settings Windowと設定の責務 |
| [Session UI Copy](session-character-copy.md) | UI copyの所有とTitle Case規則、会話・定義等の原文との分離 |
| [Electron Window Runtime](electron-window-runtime.md) | BrowserWindow、preload、runtime |
| [Message Rich Text](message-rich-text.md) | メッセージの表示とresourceの扱い |

### Session・provider

| 文書 | 内容 |
| --- | --- |
| [Session Run Lifecycle](session-run-lifecycle.md) | 実行・取消・終了と永続化の境界 |
| [Auxiliary Session](auxiliary-session.md) | 複数Auxiliary、一覧、共通Composer、draftの保存・consume・flush |
| [Electron Session Store](electron-session-store.md) | Session・turn・設定・catalogの読書きと保存owner |
| [Session Graph](session-graph.md) | Main/Auxiliary共有の構造化記録、MCP、競合、閲覧図 |
| [Provider Adapter](provider-adapter.md) | provider連携とadapterの境界 |
| [Coding Agent Capability Matrix](coding-agent-capability-matrix.md) | providerごとの対応機能 |
| [Provider Usage Telemetry](provider-usage-telemetry.md) | usage、quota、context情報 |
| [Provider Model Discovery](model-catalog.md) | SDK model一覧の取得、cache、選択と実行の境界 |
| [Prompt Composition](prompt-composition.md) | providerへ渡すpromptの構成 |

### Character・Memory・永続化

| 文書 | 内容 |
| --- | --- |
| [Character Definition Format](character-definition-format.md) | Character定義・補助メモの形式 |
| [Character Storage](character-storage.md) | catalog、storage、snapshotの境界 |
| [Character Authoring And Improvement](character-authoring-growth.md) | 通常Sessionを使うCharacter作成・改善 |
| [Database Schema](database-schema.md) | SQLiteとfile storageの保存構造 |
| [V6 Database Foundation](v6-database-foundation.md) | DBの責務と移行・データ境界 |
| [V6 Memory Foundation](v6-memory-foundation.md) | Memoryのowner、scope、API、storage、privacy |
| [V6 Memory Protected Objects](v6-memory-protected-objects.md) | Memoryに紐づく暗号化file object、quota、export、GC |
| [Session Local Files](session-local-files.md) | Session Folderと添付ファイル |

### 開発・検証・配布

| 文書 | 内容 |
| --- | --- |
| [Agent Guide](../../AGENTS.md) | 作業内容に応じた参照先と、課題管理・互換性の入口 |
| [Development Workflow](../runbooks/development-workflow.md) | 回答・実装境界・検証手順・課題とMilestoneの完了運用・Git操作の規則 |
| [App Log Base](app-log-base.md) | クラッシュ・フリーズ調査用の診断ログとcrash dump |
| [Distribution Packaging](distribution-packaging.md) | installer、app bundle、配布build |

## 設計判断とリリースの履歴

| 文書 | 役割 |
| --- | --- |
| [ADR](../adr/) | 設計判断の背景、代替案、採否、結果、置換関係。各ADRの適用状態を確認し、判断の採用と実装済みの状態を区別する |
| [Release Notes](../releases/README.md) | versionごとの変更内容、互換性、当時の検証結果・利用上の注意を恒久保存する |
