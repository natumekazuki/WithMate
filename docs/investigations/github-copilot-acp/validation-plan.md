# GitHub Copilot ACP Validation Plan

- 作成日: 2026-07-10
- 状態: 計画済み / 現在の開発環境では実行不可
- 関連設計: `docs/design/provider-integration.md`

## 目的

GitHub Copilot CLI の ACP server を WithMate の Provider Adapter から利用できるか判断するため、設計上の未確認事項を契約済みの別環境で検証する。

## 環境上の制約

現在の開発環境では GitHub Copilot を契約していないため、認証後の Session 作成、prompt 実行、streaming、permission、cancel などの runtime 検証は実行できない。

検証コードを作成する場合は、次を同じ変更単位で用意する。

1. 再現可能な検証コード
2. 本書の実行手順、期待結果、判定基準
3. `docs/investigations/github-copilot-acp/validation-results.md` の結果記録欄

## 実行前提

- GitHub Copilot 契約が有効な検証用 account を使用できる。
- GitHub Copilot CLI がインストール済みで認証できる。
- 検証対象の repository または directory に機密情報が含まれていない。
- 実行環境の OS、CPU architecture、GitHub Copilot CLI version、ACP protocol version、runtime version を記録できる。
- 検証コードの commit を特定できる。

## 証跡の記録方針

- token、cookie、authorization header、account ID、email address を記録しない。
- private repository の URL、remote、source、issue、pull request 情報を記録しない。
- local absolute path は `<workspace>`、`<home>` などへ置換する。
- prompt と response は検証用の無害な固定文を使用する。
- raw NDJSON を保存する場合は sanitize 後の file のみを repository へ追加する。
- sanitize 前の raw log は commit、共有、貼り付けを行わない。

## テスト項目

| ID | 確認内容 | 期待結果 | 設計判断への用途 |
| --- | --- | --- | --- |
| ACP-001 | `copilot --acp --stdio` の起動と初期接続 | client が protocol version と capability を取得できる | process / handshake contract |
| ACP-002 | 新規 Session 作成 | Session ID を取得できる | Provider binding |
| ACP-003 | prompt 送信 | prompt が受理され、処理開始を識別できる | Run 開始 contract |
| ACP-004 | assistant message の途中出力 | chunk を順序付きで受信できる | streaming projection |
| ACP-005 | 正常完了 | terminal result と最終状態を一意に識別できる | `completed` 判定 |
| ACP-006 | cancel | in-flight Run を停止し、terminal state を識別できる | `canceling` / `canceled` 判定 |
| ACP-007 | permission request | request を受信し、allow / deny / cancel を返せる | approval contract |
| ACP-008 | Session 再開 | process または connection の再作成後に会話を継続できる | crash / reconnect design |
| ACP-009 | 実行中の追加指示 | immediate steering または queueing の対応可否を確認できる | asynchronous instruction |
| ACP-010 | 複数 Session の並行実行 | event を Session / Run ごとに相関できる | concurrency / correlation |
| ACP-011 | client 切断 | Run と Session がどう扱われるか観測できる | daemon / disconnect policy |
| ACP-012 | CLI 異常終了 | process exit と未完了 Run を検出できる | `interrupted` 判定 |
| ACP-013 | 未知 event | client が crash せず event を診断記録できる | forward compatibility |
| ACP-014 | model / capability 取得 | 利用可能な model と設定範囲を取得できる | model catalog / fallback |

## 実行手順へ記載する内容

検証コード作成時に、各 test case について次を具体化する。

- 実行 command
- 使用する固定 prompt
- 必要な permission 設定
- timeout
- expected request / response / notification sequence
- pass / fail / blocked の判定条件
- sanitize 済み evidence の保存先
- cleanup 手順

一括実行 command を 1 つ用意し、個別 test case も選択実行できるようにする。

## 完了条件

- 別環境の実行者が本書と検証コードだけで再現できる。
- 全 test case が `pass`、`fail`、`blocked`、`not_run` のいずれかで記録される。
- 実行環境と検証コードの revision が記録される。
- design を確定できる結果と、追加調査が必要な結果が分離される。
- `docs/design/provider-integration.md` の Open Questions に対する影響が記録される。
