# Multi-Agent 詳細設計の入口

- 作成日: 2026-07-11
- 状態: 次回設計セッションの開始点
- 正本: `docs/design/multi-agent-orchestration.md`

## Task Brief

Goal: Multi-Agent の確定済み orchestration contract を、実装判断に使える persistence / Application Service / CLI / Hook 契約へ落とす。
Scope: DB model、状態遷移、atomic transaction、CLI operation、Hook payload、復旧、contract test の設計。
Out of scope: 実装コード、file diff 管理、Character 呼称 matrix、高度な自動 model 選定。
Done when: table 関係、操作入出力、不変条件、失敗時の補正、検証項目が実装担当へ引き渡せる。
Risks: SQLite write 競合、capacity admission race、Provider 再接続不能、Session / Run / Delegation 状態の二重更新。

## 最初に読む文書

1. `docs/design/multi-agent-orchestration.md`
2. `docs/design/session-run-message-contract.md`
3. `docs/design/provider-integration.md`
4. `docs/investigations/codex-app-server/capability-matrix.md`
5. `docs/investigations/github-copilot-acp/validation-results.md`

`docs/design/` が仕様の正本であり、本書から確定済み方針を上書きしない。runtime 検証結果が正本と矛盾する場合は、Provider Adapter で吸収できるかを先に検討する。

## 再検討しない確定事項

- 通常 Session と child Session を型や table で分けない。
- Session は粗い execution projection を永続化し、詳細な実行状態は Run を正本とする。
- SessionRelation、Delegation、ChildResultDelivery、Run の状態を分離する。
- 同期・並行・バックグラウンドの選択と待機位置は呼び出し元 Agent に委ねる。
- 子は複数・入れ子で起動でき、同時実行上限は `orchestrationRootSessionId` 配下の全子孫で共有する。
- capacity check と slot reservation は root 単位の atomic admission とし、上限超過時は queue を作らず即時 error を返す。
- 結果本文は child Session を正本とし、親へ unsolicited Message や全文の自動注入を行わない。
- 未回収結果は親 Run 開始時に最大 20 件の ID / 状態 metadata だけを Hook へ通知する。
- 親終了時に child Session を既定で cascade cancel せず、UI / CLI から個別 Kill できるようにする。
- 指示差し戻しと評価登録を分離し、登録済み評価だけを集計する。
- Provider を Agent へ見せず、model、reasoning depth、特徴、評価分析を提示する。
- WithMate は file diff、merge、commit ownership を管理しない。

## 設計の進行順

### 1. Persistence / Data Model

最初の成果物として `docs/design/multi-agent-persistence.md` を作成する。

最低限、次を決める。

- Session execution projection の column、index、versioning、repair rule
- SessionRelation と `orchestrationRootSessionId` の制約、cycle 防止方法
- Delegation、ChildResultDelivery、evaluation record の table と参照整合性
- root 単位の capacity admission を直列化する transaction / actor 境界
- `startChild` の durable commit と Provider 起動の順序
- terminal Run、Session projection、Delegation、delivery state の同時更新境界
- idempotency record、duplicate terminal event、再送時の response 保存方法
- Main Process から SQLite を同期操作しない Persistence Worker / actor contract
- child Session 失効時の delivery tombstone

### 2. Application Service / CLI Contract

Persistence 設計の ID と transaction 境界を入力に、次を具体化する。

- `startChild`、status、wait、waitAny、waitAll、list、collect、cancel / Kill
- Session / relation / Delegation の検索と詳細取得
- `clarification_required` の response envelope と補足指示による再開
- evaluation record の登録、一覧、初期集計
- error code、retryable 判定、idempotency key
- Provider を露出しない model / reasoning depth capability 表現

### 3. Hook / Character Payload

- Multi-Agent 操作を案内する静的 Hook prompt
- 親 Run 開始時に追加する未回収 result metadata
- `instruction` と UI 用 `mentionText` の分離
- Character のランダム割当と Run snapshot
- instruction assessment / outcome evaluation を促す soft control

### 4. Recovery / Retention

- 未 dispatch Run の安全な開始
- 継続中の外部実行へ一意に再接続できる場合の監視再開
- outcome を証明できない Run / Session / Delegation の `interrupted` 補正
- Session retention / delete policy と ChildResultDelivery の `expired` 遷移
- startup repair の順序、冪等性、診断情報

### 5. Contract Test Matrix

各詳細設計で確定した状態遷移と競合条件を、実装前の contract test 入力へ変換する。基礎ケースは `docs/design/multi-agent-orchestration.md` の「検証 Gate」を使用する。

## 最初の設計セッションの完了条件

`docs/design/multi-agent-persistence.md` に次が揃った時点で、最初の設計セッションを完了とする。

- entity / table 関係図
- primary key、foreign key、unique constraint、主要 index
- `startChild` admission と terminal update の transaction sequence
- DB lock を避ける write ownership と queue / actor 境界
- crash recovery と projection repair の sequence
- 主要 race condition に対する許可 / 拒否結果
- Application Service / CLI 設計へ渡す ID、状態、error の一覧

## 後続 scope

- Character 間の呼称 matrix と設定 UI
- evaluation sample が蓄積された後の重み付け、時間減衰、自動 model 選定
- Provider 追加時の capability 拡張
- Session 全体の privacy / retention / delete policy

