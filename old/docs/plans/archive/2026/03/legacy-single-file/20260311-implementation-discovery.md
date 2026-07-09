# キャラクター協働型AIデスクトップアプリ 実装検討計画

- 作成日: 2026-03-11
- 対象要件: `docs/要件定義_叩き.md`
- 現在方針: Phase1 は Codex 先行で検証を進め、Copilot 対応は後続設計へ送る

## Goal

`docs/要件定義_叩き.md` を実装可能な粒度へ分解しつつ、最初の着手として `Codex SDK` の接続方式を確認し、ローカルからプロンプト送信できる最小テストを成立させる。

## 現状整理

- リポジトリには現時点で要件叩き台のみが存在し、アプリ本体コード・設計ドキュメント・AI コンテキスト定義は未作成。
- 初手では Provider 抽象化を作り込みすぎず、`Codex` のセッション開始・メッセージ送信・レスポンス受信の最小経路を実証する。
- `Copilot` は将来の Adapter 対応対象として保持し、今回のスパイクでは対象外とする。

## Task List

- [x] `Codex SDK` の公式一次情報を確認し、認証方式・主要 API・制約を整理する
- [x] `Codex` 先行スパイク用の設計メモを `docs/design/` に作成する
- [x] TypeScript 実行環境を最小構成で作成する
- [x] `Codex SDK` を使って単発プロンプトを送信するスモークテストを実装する
- [x] 実行方法と必要な前提条件をドキュメント化する
- [x] `Codex SDK` から `workspace-write` でファイル操作できるかを検証する
- [x] `Codex CLI` と `Codex SDK` の機能対応表を作成し、再現方針を整理する
- [x] メイン画面の静的 UI モックを作成する
- [x] メイン画面の React UI モックを作成する
- [ ] このスパイク結果を次の Provider Adapter 設計へ反映する

## Affected Files

- `docs/要件定義_叩き.md`
- `docs/plans/20260311-implementation-discovery.md`
- `docs/design/codex-sdk-spike.md` (新規予定)
- `docs/design/codex-sdk-cli-parity.md` (新規予定)
- `docs/design/ui-static-mock.md` (新規予定)
- `docs/design/ui-react-mock.md` (新規予定)
- `package.json` (新規予定)
- `tsconfig.json` (新規予定)
- `vite.config.ts` (新規予定)
- `src/main.tsx` (新規予定)
- `src/App.tsx` (新規予定)
- `src/styles.css` (新規予定)
- `scripts/codex-sdk-smoke-test.ts` (新規予定)
- `scripts/codex-sdk-file-op-test.ts` (新規予定)
- `mock/main-screen/index.html` (新規予定)
- `mock/main-screen/style.css` (新規予定)
- `.gitignore` (必要に応じて新規予定)
- `.ai_context/system_spec.yaml` (後続で新規予定)

## Design Check

新規機能の実装に入るため、スパイク範囲でも `docs/design/` の作成を先行する。
今回の着手では以下を最優先とする。

- `docs/design/codex-sdk-spike.md`
  - 調査対象 SDK
  - 想定する認証方式
  - 単発プロンプト送信テストの責務
  - 今回は未対応とする範囲

後続で以下を拡張する。

- `docs/design/system-architecture.md`
- `docs/design/provider-adapter.md`
- `docs/design/session-persistence.md`
- `docs/design/character-system.md`

## Risks

- `Codex SDK` の推奨実行形態が Electron 本体実装と合わず、後で呼び出しレイヤーの見直しが必要になる可能性がある
- `codex` CLI のログインセッション参照方法が Electron 実行環境と噛み合わない場合、認証まわりの設計追加が必要になる可能性がある
- スモークテストは成功しても、後続のストリーミングやセッション再開 API が別経路になる可能性がある

## Notes / Logs

- 2026-03-11: ユーザー方針により、初期検証は `Codex` 先行で進める。
- 2026-03-11: 最初の成果物は Electron 統合ではなく、`Codex SDK` に対する単発プロンプト送信の成立確認とする。
- 2026-03-11: `npm run codex:smoke -- "接続確認として、日本語で1文だけ返して。"` を実行し、CLI ログイン前提で応答取得に成功した。
- 2026-03-11: 追加検証として、CLI 相当のファイル操作が `workspace-write` で実行可能か確認する。
- 2026-03-11: `npm run codex:file-op` を実行し、`workspace-write` で一時ファイルの新規作成と `file_change` イベント取得に成功した。
- 2026-03-11: 次段では「CLIで出来ることをSDKでどこまで再現できるか」を設計ドキュメントとして整理する。
- 2026-03-11: 次の着手は、要件のメイン画面をベースにした静的 UI モックの作成とする。
- 2026-03-11: 静的モックの次段として、操作感が分かる React ベースのモックを作成する。
- 2026-03-11: `React + Vite` のモック環境を構築し、セッション切り替えと入力欄反応があるメイン画面モックを作成した。
- 2026-03-11: React モックの左カラムから無効な `Navigation` を撤去し、開閉できる `Session Drawer` 構成へ整理した。
