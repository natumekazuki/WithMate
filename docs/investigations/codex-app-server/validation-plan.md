# Codex App Server Validation Plan

- 作成日: 2026-07-10
- 対象 version: `codex-cli 0.144.1`
- 関連設計: `docs/design/provider-integration.md`
- 状態: 基本通信を実施済み / lifecycle 詳細は継続調査

## 目的

Codex App Server を WithMate の Provider Adapter から利用するため、schema だけでは確定できない message 順序、状態遷移、再接続、承認、追加入力を小規模に検証する。

検証は product implementation と分離し、無害な固定 prompt、機密情報を含まない一時 workspace、最小権限で実施する。

## 証跡の記録方針

- token、account 情報、rate limit、installation ID、端末名を記録しない。
- local absolute path は `<workspace>`、`<home>` へ置換する。
- Thread ID、Turn ID、item ID は `<thread-id>` などへ置換する。
- payload 全体ではなく、設計判断に必要な request / notification 順序だけを残す。
- model 一覧は取得可否と capability field の存在を記録し、変動する catalog 全体は保存しない。

## 検証項目

| ID | 確認内容 | 期待結果 | 優先度 |
| --- | --- | --- | --- |
| CAS-001 | process 起動と initialize | response を受け、以後の request を送信できる | 必須 |
| CAS-002 | model 一覧 | pagination 可能な catalog を取得できる | 必須 |
| CAS-003 | ephemeral Thread 作成 | Thread ID と初期状態を取得できる | 必須 |
| CAS-004 | Turn 開始 | Turn ID と `inProgress` を取得できる | 必須 |
| CAS-005 | assistant streaming | delta を順序付きで受信できる | 必須 |
| CAS-006 | 正常完了 | item、Thread、Turn の terminal event を識別できる | 必須 |
| CAS-007 | Thread 読取 | ephemeral / persistent の制約を識別できる | 必須 |
| CAS-008 | persistent Thread 再開 | process 再起動後に会話を継続できる | 高 |
| CAS-009 | Turn interrupt | user cancel と terminal status を対応付けられる | 高 |
| CAS-010 | Turn steer | active Turn へ追加指示を送信できる | 高 |
| CAS-011 | command / file approval | server request へ allow / deny を返せる | 高 |
| CAS-012 | permission / user input / elicitation | pending state と回答を相関できる | 高 |
| CAS-013 | stdio App Server異常終了 | 未完了Runを復旧または`interrupted`判定できる | 高 |
| CAS-014 | 複数 Thread の並行実行 | event を Thread / Turn / item ごとに相関できる | 中 |
| CAS-015 | 未知 notification | client が停止せず診断記録できる | 中 |
| CAS-016 | assistant phase 分類 | `commentary` / `final_answer` / `null` と Turn 成功完了から final Message / assistant detail を一意に分類できる | 必須 |
| CAS-017 | daemonへのclient-only再接続 | App Server daemonを停止せずclientだけ切断し、active Turnの監視を再開できるか判定できる | 高 |

## 基本通信の実行条件

- `thread/start` は `ephemeral: true` とする。
- sandbox は `read-only`、approval policy は `never` とする。
- prompt は固定文字列の返答だけを要求し、tool や file access を禁止する。
- 検証 workspace は repository 外の一時 directory とする。
- process は検証後に標準入力または interrupt で終了する。

## lifecycle 検証時の追加条件

CAS-008 以降は永続 Thread、長時間 Turn、承認対象 action を扱うため、個別の実行手順と cleanup 方針を追加してから実行する。特に file 変更や command 実行を伴う検証は、専用の破棄可能 workspace と明示的な test command を使用する。

CAS-008 / CAS-013 の復旧 probe は次の条件で実行する。

- `docs/investigations/codex-app-server/recovery-probe.mjs` を使用する。
- repository 外に一時 workspace を作り、終了時に削除する。
- persistent Thread、`read-only` sandbox、`approvalPolicy=never` を使用する。
- completed Turn の App Server 再起動後に `thread/read(includeTurns=true)` と `thread/resume` を確認する。
- active Turn は最初の assistant delta を受信した直後に App Server process tree を終了し、別 process から同じ Thread ID を `thread/resume` する。
- prompt は file / command / network accessを伴わない固定出力だけにする。
- Thread / Turn / item ID、absolute path、本文、token / account情報を証跡に残さない。

実行 command:

```text
node docs/investigations/codex-app-server/recovery-probe.mjs
```

## 完了条件

- 各項目が `pass`、`fail`、`blocked`、`not_run` のいずれかで記録される。
- 実行した Codex CLI version と OS を記録する。
- request / notification の相関 key と terminal 判定を説明できる。
- Provider Adapter の状態遷移に反映できる。
- 未実施項目と残リスクが `validation-results.md` に残る。
