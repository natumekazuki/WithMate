# WithMate Agent Guide

## Language

- ユーザーへの回答、生成ドキュメント、コミットメッセージは日本語で書く。
- repo 内ファイルは repo root 相対パスで示す。
- 不明な仕様、API、依存関係は断定しない。実装、設計文書、既存テストを確認してから答える。

## Project Structure

WithMate は Electron + React + TypeScript のデスクトップアプリである。

- `src/`: renderer 側の React UI、状態管理、window API 型。
- `src-electron/`: main process、preload、IPC、永続化、provider 連携。
- `scripts/`: 生成、migration、検証用スクリプト。
- `scripts/tests/`: Node test runner 用の `*.test.ts` / `*.test.tsx`。
- `docs/design/`: 現行設計の正本。
- `docs/features/`: 現在利用できる機能のガイド。
- `docs/runbooks/`: 現在の運用・診断・復旧手順。
- `docs/adr/`: 設計判断の履歴。現在の適用状態と過去の判断を区別する。
- `docs/releases/`: リリースノートと索引。ADRとは別枠で恒久保存する。
- `build/`: packaging 入力。icon は `build/icon.svg` を source of truth とする。

## Documentation Policy

- 一般文書には、対象branchの現行実装・設定・呼び出し経路について正しく、現在の利用・開発・保守に必要な情報だけを置く。現在有効な開発規則、ライセンス、互換性・データ保護契約、サポート中の移行・復旧手順も維持する。
- 旧仕様、廃止機能、未実装の構想、作業計画、Issue／PR草稿、調査・レビュー・同期・引き継ぎ・完了記録は一般文書として残さない。新しさ、進行中・採用済み等の状態、他文書からの参照を保存理由にしない。現行に必要な情報だけを現在の正本へ統合し、元の作業文書や旧正本は削除する。
- 設計・作業文書の履歴保持を認める例外はADRのみとする。設計判断の背景、代替案、採否、結果、置換関係を保持でき、古いことや現行実装と異なることだけを理由に削除・上書きしない。適用状態や置換先を明確にし、未実装の決定を実装済み仕様として案内しない。
- リリースノートと索引はADRとは別枠でrepository内に恒久保存する。当時の変更内容・互換性・検証結果を現在の仕様へ書き換えない。削除、期限付き保存、GitHub Releasesのみへの移管は行わない。
- ADR・リリースノートから当時の資料・画像への必要な参照は、内容と存在を確認したcommit SHAへ固定する。リリースノートでは対象release tagの版を確認できる場合はtagも使える。不要な参照は除去してよい。参照されているだけの一般文書・専用assetsは保存対象にせず、現行文書からは現行の正本を直接読めるようにする。
- それ以外の過去情報はGit履歴で扱う。不要な一般文書をArchive、移転案内、完了サマリー、削除台帳、ZIPへ詰め替えない。作業文書をADR・リリースノートへ改名・丸ごと転記して保存基準を迂回しない。
- 課題・不具合・レビュー残件・作業計画の管理先はGitHub Issue／PRとする。実際に追跡が必要な未解決事項だけを既存の対応Issue／PRへ集約し、元文書の削除で失わないようにする。対応先がなければ依頼元へ追跡先未確定として報告し、未解決・未確認を完了扱いにしない。管理先の指定は外部writeや新規Issue作成の許可を代替しない。
- 一時的な計画、棚卸し、検証記録は提供されたSessionFolder等のrepository外で扱い、repository内に別名の作業文書置き場を作らない。Skill等の旧配置規則と衝突する場合もこの保存方針に合わせ、外部の設定やhookは無断変更しない。
- 仕様・実装を変更した論理変更単位で、対応する一般文書の現行化・不要情報の削除と、必要なADRの適用状態・置換関係の更新を行う。文書に合わせて廃止機能・未実装構想を復活させたり、実装の不具合に合わせて契約を弱めたりしない。

## Coding Style

- TypeScript は `strict` 前提で扱う。
- ES modules、`NodeNext`、React JSX runtime の既存構成に合わせる。
- 既存コードに合わせ、2 spaces、double quotes、末尾セミコロンを基本にする。
- ファイル名は kebab-case を優先し、React component は既存に合わせて PascalCase を使う。
- 共通処理は既存 helper と service 層へ寄せる。
- 無関係な整形、rename、refactor を混ぜない。
- 生成物やドキュメントに個人環境の絶対 path を残さない。

## UI Architecture

チャット体験はアプリの主要 UI であり、実装の分岐を増やさない。

- チャット UI の layout / message list / composer / right pane shell は 1 系統を正本にする。
- 会話機能ごとの差分は mode、capability、service adapter で切り替える。
- 新しい会話機能を追加するときも、独自 chat layout を作らない。
- 機能ごとに不要な操作は非表示にしてよいが、構造と操作感は既存の Session UI に揃える。
- 出す情報がない right pane を説明文で埋めない。

## UI Design

- アプリ内UIのユーザー向け表示文字列は英語を標準とする。UIを新設・変更する場合は英語を使用し、空文字列が既存契約に適する場合はそれを優先する。Character定義、ユーザー入力・生成コンテンツ、provider向け指示、ログ、テストデータ、開発者向け文書はこの規約の対象外とする。
- 文字色と背景色が近すぎて読めない組み合わせを作らない。
- theme token や既存 CSS variable を優先し、場当たり的な色指定を増やさない。
- 新しい背景色、surface 色、badge 色、button 色を追加する場合は、その上に乗る text / icon / border の contrast も同時に確認する。
- disabled、muted、placeholder、secondary text は薄くしすぎない。背景と同化する場合は色ではなく opacity、weight、spacing、label の整理で調整する。
- hover、selected、active、focus、error、warning、success の各 state で文字が背景に埋もれないことを確認する。

## Data And Privacy

- 永続化データの正本と投影結果を混同しない。
- Markdown や provider instruction が generated projection の場合、手編集を正本にしない。
- ユーザーが削除または忘却した情報は、UI 表示だけでなく projection や provider instruction に残らないように扱う。
- secret、token、個人環境 path を commit しない。

## Compatibility Boundary And Releases

- 互換性・継続性の維持対象は、リリースタグが付与された commit の状態とする。正式版だけでなく preview 等のプレリリースタグも含む。対象は Git のリリースタグとその参照先 commit で判定する。
- タグ付き commit で成立したデータ形式・公開契約を変更する場合は、その状態からの継続性を維持する。タグより後の未リリースの開発途中状態は新たな維持対象にせず、現在の実装・定義を直接修正する。途中状態だけを理由としたバージョン更新、追加 migration、旧形式維持、互換分岐を追加しない。
- 境界は互換対応の要否を定めるものであり、ユーザーデータの破棄や環境の再作成を許可するものではない。既存の明示された移行契約を無断で拡張・撤回しない。
- リリース時は、preview を含め、対象 commit へのリリースタグ付与とリリースノート作成を必須とする。リリースノートは対象タグ・バージョン、変更内容、互換性・移行、実際の検証結果と未確認事項を明記し、`docs/releases/` に保存して一覧へ追加する。
- ノートと索引の恒久保存・履歴参照には上記Documentation Policyと[リリースノートの保存・参照規則](docs/releases/README.md#保存と参照)を適用する。新規ノートの対象tag・参照commitの実在と参照内容はリリース時に確認する。
- 通常の実装 commit はリリースではない。この規則だけでタグ付与・push・外部公開を許可されたと解釈せず、リリース操作は明示された対象と scope で行う。

## Commands

- `npm install`: 依存関係を導入する。
- `npm run dev`: Vite renderer dev server を起動する。
- `npm run electron:dev`: Electron main を build して開発起動する。
- `npm run build`: renderer と Electron main を本番向けに build する。
- `npm run typecheck`: renderer と Electron の TypeScript 型検査を実行する。
- `npm test`: `scripts/tests/*.test.ts(x)` を `tsx --test` で実行する。
- `npm run dist:win`: Windows installer を作成する。
- `& .\scripts\start-withmate-visual-check.ps1`: 現在の Worktree を build し、`%APPDATA%\WithMate-visual-check` を使う検証用 Electron を起動する。既存の検証用プロセスは安全に識別できる場合だけ差し替え、インストール版 WithMate は停止しない。

## Testing

- 変更種別に合う最小の targeted test を優先する。
- 永続化、migration、IPC、provider adapter を変更した場合は、関連 test に加えて TypeScript 型検査を実行する。
- UI 変更では、可能なら state / projection / component test を追加または更新する。
- UI 変更や branch 固有の smoke / 目視確認が有効な場合、agent は `scripts/start-withmate-visual-check.ps1` による分離起動を候補としてユーザーへ提案する。実行する場合は対象 Worktree の root から呼び出し、検証用プロセスが差し替わることを明示する。
- 全体検証が既存の unrelated failure で落ちる場合は、関係する failure と unrelated failure を切り分けて報告する。
- 検証できない場合は、理由、代替確認、残リスクを明記する。

## Git

- commit は 1 つの論理変更単位を基本にする。
- commit message は conventional commits を使う。
- commit 前に `git status --short` を確認し、ユーザー由来の無関係変更を混ぜない。
- `AGENTS.md` はユーザーが明示するまで commit しない。
- push はユーザーが明示した場合だけ実行する。
