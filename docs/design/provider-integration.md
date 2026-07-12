# Provider Integration

- 作成日: 2026-07-10
- 対象: WithMate 新実装の Provider 接続、会話履歴、実行状態、CLI 境界
- 状態: 設計の基準

## 目的

WithMate の中核機能を画面に依存させず、CLI と将来の GUI が同じ Application Service を利用できる構造にする。

Codex と GitHub Copilot は SDK をアプリケーションへ直接組み込まず、それぞれの CLI を別 process として起動し、公開された JSON-RPC 系 protocol で接続する。Provider 固有の会話・実行・event は Adapter 内で WithMate 共通 contract へ変換する。

## 対象範囲

新実装で対応する Provider は次の 2 つに限定する。

| Provider | 接続先 | Transport | Protocol |
| --- | --- | --- | --- |
| Codex | `codex app-server` | stdio の JSONL を第一候補とする | Codex App Server protocol |
| GitHub Copilot | `copilot --acp --stdio` | stdio の NDJSON を第一候補とする | Agent Client Protocol (ACP) |

Cursor その他の Provider は今回の再実装対象に含めない。

## 設計判断

### 1. アプリケーション機能の正式な窓口を先に設計する

- WithMate の use case は画面に依存しない Application Service として提供する。
- CLI と GUI は Application Service の client として扱う。
- CLI に business logic、DB 直接操作、Provider process の状態遷移を埋め込まない。
- GUI の本格実装は後段とし、主要 use case を CLI から実行・観測できることを先に目標とする。
- GUI 固有の layout や一時的な表示状態は CLI 対応の対象外としてよい。

```text
Codex App Server / GitHub Copilot ACP
                  ↓
            Provider Adapter
                  ↓
      WithMate Application Service
                  ↓
       Runtime / Persistence / Event
            ┌─────┴─────┐
           CLI         GUI
```

### 2. Provider CLI を別 process に分離する

- Codex と GitHub Copilot の CLI は WithMate と別 process で実行する。
- process 起動、終了監視、標準入出力、標準エラー、timeout、protocol version、CLI version の記録は共通 infrastructure 候補とする。
- wire protocol の message 型と lifecycle は Provider ごとに異なるため、Codex App Server と ACP を 1 つの汎用 protocol 型へ統合しない。
- SDK 内部の非公開または SDK による互換処理を前提とする JSON-RPC へ直接依存しない。

### 3. GitHub Copilot は ACP で接続する

- GitHub Copilot は Copilot SDK を使用せず、GitHub Copilot CLI の ACP server に接続する。
- ACP は外部 client、専用 frontend、multi-agent system から利用する公開 protocol として扱う。
- ACP は 2026-07-10 時点で public preview のため、protocol 変更を前提に version negotiation、capability detection、CLI 対応 version、契約 test を設計する。
- ACP に必要な機能が存在しない場合、SDK 内部 protocol への切り替えを暗黙に行わない。欠落機能、代替手段、初期 scope への影響を再評価する。

### 4. 会話履歴は WithMate が保持する

WithMate は複数 Provider の会話を同じ CLI / GUI から参照できる必要があるため、表示・管理用の共通会話履歴を WithMate 側で保持する。

- WithMate の Session / Message を共通会話履歴の正本とする。
- Provider 側の Thread / Session は、その Provider で会話を継続するための外部状態として扱う。
- WithMate Session と ProviderBinding は Provider 種別と外部会話 ID の対応を保持する。protocol version、CLI version、capability は Binding へ混在させず、Provider process / 接続環境の診断として扱う。
- DB schema、event ledger、RunOutput payloadのSQLite BLOB構造はpersistence designで定める。
- 旧実装の「WithMate が共通会話履歴を保持する」という思想は踏襲するが、旧 DB schema と storage 実装は引き継がない。

```text
WithMate Session
├─ WithMate common message history
├─ Character snapshot
└─ Provider binding
   ├─ Codex Thread ID
   └─ Copilot ACP Session ID
```

### 5. Session と Run を分離する

- Session は会話全体を表す。
- Run は 1 件の initiating user message を起点とする Provider 実行を表す。実行中の追加指示は同じ Run の supplemental input として関連付けられる。
- Message は WithMate の共通会話履歴へ表示する単位を表す。
- 実行中状態は Session の永続的な性質ではなく、Session に属する active Run の状態として扱う。
- Session / Run / Message / RunEvent の責務と不変条件は `docs/design/session-run-message-contract.md` を正本とする。Codex App Server 固有の Thread / Turn / item / server request 変換は `docs/design/codex-app-server-adapter-contract.md` に従う。

```text
Session
├─ Run 1: completed
├─ Run 2: completed
└─ Run 3: running
```

### 6. Provider 共通の Run phase / live activity は WithMate が管理する

Provider は実際の処理状態と Provider 固有 event を所有する。WithMate はそれらを永続化する共通Run phaseと、Main processでメモリ管理するlive activity / live interaction、terminal outcomeへ変換し、CLI / GUIへ提供する。

- phase は `queued`、`starting`、`active`、`canceling`、`finalizing` と terminal phase を表す。
- live activity はactive Runの`running`、`waiting_approval`、`waiting_input`を表し、DBへ保存しない。
- approval / elicitationのrequest本体はlive activityへ埋め込まず、request IDごとのlive interactionとしてMain processのメモリで管理する。

状態遷移、terminal outcome、retry / recovery の契約は `docs/design/session-run-message-contract.md` で定める。Provider の terminal event、WithMate process の crash、persistence failure を同一の失敗として扱わない。

## Provider 共通境界

Provider Adapter が WithMate へ公開する最小操作候補:

- 新しい外部会話を開始する
- 既存の外部会話を再開する
- message を送信して Run を開始する
- 実行中の Run へ追加指示を送る
- Run を cancel する
- approval request へ回答する
- elicitation request へ回答する
- Provider capability、model、protocol version を取得する
- 外部会話を終了または解放する

Provider Adapter が WithMate へ公開する最小 event 候補:

- Run 開始
- assistant message の途中出力
- tool / command 実行の開始、更新、終了
- approval request
- elicitation request
- Run の正常完了、失敗、cancel、中断
- Provider process または transport の異常
- 未対応の Provider event

未対応 event は無視して消失させず、secret を除去した診断情報として記録できるようにする。

## CLI 境界

CLI contract の詳細は後続 design で確定する。現時点では次を固定する。

- machine-readable な結果は stdout へ JSON で出力する。
- human-readable な diagnostic は stderr へ出力する。
- 成否と主要な失敗種別を exit code で判別できるようにする。
- destructive operation は明示確認または confirmation token を要求する。
- retry されうる write operation は idempotency key を受け取れるようにする。
- 長時間実行は開始、状態取得、event 追跡、結果取得、cancel を分離できるようにする。

## 検証方針

- 設計で確定できない Provider 挙動だけを小規模検証の対象とする。
- 検証コードは product implementation ではなく、破棄可能または隔離された investigation asset として扱う。
- 検証には手順、期待結果、実行環境、結果記録、設計への影響を必ず揃える。
- GitHub Copilot を契約していない現在の開発環境では ACP の runtime 検証を実行しない。
- Copilot ACP 検証は契約済みの別環境で実施し、`docs/investigations/github-copilot-acp/validation-results.md` に記録する。
- raw protocol log を保存する場合は token、account 情報、private repository 情報、絶対 path、prompt 内の secret を除去する。

## Codex App Server 調査で確定した前提

- stdio 上の newline-delimited JSON で初期化、model 取得、Thread 作成、Turn 実行、assistant streaming、正常完了を確認した。
- WithMate Session / Run / event は Codex Thread ID / Turn ID / item ID と対応付ける。
- Run の terminal 判定には `turn/completed` の status を使う。`thread/status/changed(idle)` だけでは正常完了と判定しない。
- Codex Turn status は `inProgress`、`completed`、`failed`、`interrupted` を持つ。
- Provider 側の永続 Thread item は完全な event ledger ではないため、WithMate の共通会話履歴と Run event を正本にする。
- ephemeral Thread は `thread/read(includeTurns=true)` を利用できない。transport の smoke test と、永続履歴・resume の検証を分ける。
- completed persistent ThreadはApp Server process再起動後に履歴をread / resumeできる。
- stdio App Server processをactive Turn中に終了すると、再起動後は同じTurnが`interrupted`となる。切断前の未確定assistant deltaはProvider履歴から復元できない。streaming deltaを永続化しない方針に従い、crash時の未確定draft消失を許容し、復旧時に推測でpartial outputを生成しない。
- model catalog は `model/list` から取得できる。version / account による差分を前提に起動時または明示 refresh で取得する。

詳細は `docs/investigations/codex-app-server/capability-matrix.md` と `docs/investigations/codex-app-server/validation-results.md` を参照する。

## 未決事項

- CLI client の終了後も Run を継続する常駐 process / daemon を採用するか。
- Provider を変更する linked Session へ、どの context を引き継ぐか。
- 将来 1 つの Session に複数 active Run を許可する場合、branch / merge contract をどう定義するか。
- Provider 側 conversation history と WithMate message の欠落・重複をどう照合するか。
- 常駐daemonを残したclient-only切断時にactive Turnへ再接続し、terminal eventを継続受信できるか。
- Codex App Server と ACP で共通化できる approval / elicitation contract の範囲。
- ACP で Session list、resume、steering、cancel、並行実行をどこまで利用できるか。
- Copilot ACP で Provider model catalog を取得できない場合の fallback。

## 参照

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [GitHub Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [GitHub Copilot SDK and CLI compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility)
- `docs/feature-inventory.md`
- `docs/issue-triage.md`
- `docs/design/session-run-message-contract.md`
- `docs/design/codex-app-server-adapter-contract.md`
- `docs/investigations/codex-app-server/capability-matrix.md`
- `docs/investigations/codex-app-server/validation-plan.md`
- `docs/investigations/codex-app-server/validation-results.md`
