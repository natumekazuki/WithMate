# Codex SDK Spike

- 作成日: 2026-03-11
- 対象フェーズ: 初期スパイク

## Goal

`@openai/codex-sdk` を用いて、ローカルの Node.js 実行環境から単発プロンプト送信を行い、レスポンス受信までの最小経路を確認する。

## Scope

今回のスパイクで確認する内容は以下に限定する。

- SDK の導入方法
- 認証に必要な前提条件
- 単発プロンプト送信の API 呼び出し方法
- 標準出力でのレスポンス確認
- `workspace-write` での実ファイル操作可否

## Out Of Scope

以下は今回のスパイク対象外とする。

- Electron Main / Renderer への統合
- キャラクターシステムとの接続
- 会話履歴の永続化
- 複数 Provider の抽象化
- Character Stream の独立実行

## Assumptions

- 実行環境は Node.js 22 系を使用する
- テストコードは TypeScript で実装し、ローカル CLI から実行する
- 認証は `codex` CLI の既存ログイン状態を利用する
- 失敗時の第一目的は、本番向けの例外設計ではなく SDK 利用条件の把握とする

## Planned Files

- `package.json`
- `tsconfig.json`
- `scripts/codex-sdk-smoke-test.ts`
- `scripts/codex-sdk-file-op-test.ts`
- `.gitignore` (必要に応じて)

## Expected Output

- 指定したプロンプトを Codex に送信できる
- 成功時にレスポンス本文を標準出力で確認できる
- CLI 未ログイン時に原因が分かるエラーメッセージを出せる

## Findings

- `@openai/codex-sdk` は内部で `@openai/codex` CLI を起動し、JSONL イベントを stdin / stdout でやり取りする
- 最小呼び出しは `new Codex()` -> `startThread()` -> `thread.run(prompt)` の順で成立する
- 継続会話は `Thread` インスタンスを再利用するか、保存済み `thread_id` を `resumeThread()` に渡して再開する
- 認証まわりは SDK が直接 API を叩くのではなく、背後の `codex` CLI セッション状態に依存する
- `env` オプションを渡した場合、Node.js プロセス環境は引き継がれないため、Electron 統合時は CLI 実行環境の受け渡し設計が必要

## Initial Implementation Decision

- 今回のスモークテストは CLI 実行確認が主目的のため、Electron 統合ではなく Node.js + TypeScript の単独スクリプトとして実装する
- 書き込み事故を避けるため、Thread は `sandboxMode: "read-only"` と `approvalPolicy: "never"` を指定する
- 認証は API キーを使わず、既存の Codex CLI ログイン状態をそのまま利用する

## References

- `node_modules/@openai/codex-sdk/README.md`
- `node_modules/@openai/codex-sdk/dist/index.d.ts`
- `https://developers.openai.com/codex`
- `https://developers.openai.com/codex/auth`
- `docs/design/codex-sdk-cli-parity.md`

## Runbook

```bash
npm install
npm run codex:smoke -- "接続確認として、日本語で1文だけ返して。"
npm run codex:file-op
```

- 前提: `codex` CLI 側で ChatGPT ログイン済みであること
- 任意: `CODEX_MODEL` を設定すると使用モデルを切り替えられる

## Verification Log

- 2026-03-11: `npm run codex:smoke -- "接続確認として、日本語で1文だけ返して。"` を実行
- 結果: 応答取得成功
- 取得した `threadId`: `019cdcd3-7456-7131-b1a6-77197d55ee85`
- 2026-03-11: `npm run codex:file-op` を実行
- 結果: `workspace-write` で新規ファイル作成成功、`file_change` 1件を確認
- 取得した `threadId`: `019cdcd7-352b-7ed3-8d21-0bc0d0e929af`

## File Operation Result

- 検証スクリプトは `tmp/codex-sdk-file-op-<timestamp>.txt` を新規作成させる
- SDK から返る `turn.items` に `file_change` が含まれ、`add` と対象パスを確認できる
- 実ファイルの存在確認と内容照合の両方が成功した

## Next Design Impact

このスパイク結果は後続の `docs/design/provider-adapter.md` に反映し、以下の判断材料に使う。

- セッション API と単発実行 API の差分
- ストリーミング応答の扱い
- Electron Main Process から SDK を呼ぶ責務分離
