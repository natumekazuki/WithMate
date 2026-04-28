# Data loading optimization and memory feature review plan

- 作成日: 2026-04-27
- Plan tier: repo plan
- 対象: `docs/design/data-loading-performance-audit.md`, session / audit log / memory loading, MemoryGeneration, 独り言機能

## 目的

`docs/design/data-loading-performance-audit.md` の優先回収ポイントを実装し、起動・セッション切替・監査ログ表示・Memory Management 表示で巨大 JSON や全件 snapshot を一括処理しない構造へ寄せる。

同時に、現行の MemoryGeneration と独り言機能が AI エージェントの prompt に有益な文脈を付与できているかを確認し、トークン効率を悪化させるなら削除または縮退する方針を決める。

## 現状観測

実運用データの概要は次のとおり。

- `sessions`: 43 件
- `sessions.messages_json`: 合計約 139 MB、最大 1 session 約 32 MB
- `sessions.stream_json`: 合計約 5 KB
- `audit_logs`: 51 件
- `audit_logs` の重い JSON 列: 合計約 12 MB
- `session_memories`: 3 件
- `project_memory_entries`: 604 件
- `character_memory_entries`: 0 件

この観測から、主要なデータ読み込み負荷は `sessions.messages_json` の一覧読込と audit log 詳細列の一括読込にある。

一方で、MemoryGeneration / 独り言の削除判断はデータ容量やレンダリング負荷より、AI エージェントのトークン効率と prompt 有用性を主軸に扱う。現行実装では coding plane prompt に `Session Memory` が常設注入され、`Project Memory` が retrieval hit 最大 3 件だけ注入される。`Character Memory` と独り言は coding plane prompt には注入しない設計であるため、token 効率の直接対象は主に `Session Memory` / `Project Memory` の生成・注入経路である。

## 方針

- DB は V2 新規定義を前提にし、V1 `withmate.db` から V2 `withmate-v2.db` への移行は別スクリプトに分離する。
- まず V1 schema の SQL 正本を storage class から切り出し、V2 schema を設計・実装できる足場を作る。
- まず prompt 注入の有用性が低い Memory 経路を止めるか、注入条件を絞る。
- session 一覧と audit log 一覧の軽量化は、データ読み込みの別軸の改善として進める。
- Memory Management は snapshot 全件返却をやめ、表示中 domain / page 単位へ分割する。
- MemoryGeneration / 独り言機能は、ユーザー確認後に次のいずれかで扱う。
  - 完全削除
  - prompt 注入と自動実行だけ停止し、既存データ閲覧や手動管理は残す
  - 今回は削除せず、読み込み最適化だけ進める
- 削除する場合も既存 DB データは即時破壊せず、互換読み込みまたは無視できる移行にする。
- `docs/design/` と `.ai_context/` の影響を実装前後で確認する。

## チェックポイント

1. [x] `docs/design/data-loading-performance-audit.md` と実データ規模を確認する。
2. [x] MemoryGeneration / 独り言 / Memory prompt 注入の削除・縮退方針を確認する。
3. [x] 確定方針に従い `Session Memory` / `Project Memory` の prompt 注入を削除または縮退する。
4. [x] 確定方針に従い MemoryGeneration / 独り言の UI / IPC / background 実行経路を整理する。
5. [ ] session 一覧を summary-first に寄せ、履歴本体の不要読込を減らす。
6. [ ] audit log 一覧をページング + 詳細遅延取得へ分割する。
7. [x] Memory Management の snapshot 一括取得を分割 API に置き換える。
8. [x] MemoryGeneration / 独り言削除に関する関連設計書を同期する。
9. [x] MemoryGeneration / 独り言削除に関する対象テスト、typecheck、build を実行する。
10. [x] V1 DB schema source を切り出し、V2 migration 方針の設計書を追加する。
11. [x] V2 DB schema を確定し、schema 定数と schema test を追加する。
12. [x] V1→V2 migration dry-run と fixture test を追加する。
13. [x] V1→V2 migration write mode と安全な overwrite 復旧を実装する。
14. [x] V2 DB runtime read path の first slice として、V2 DB 選択、session / audit read adapter、legacy memory no-op adapter、V2 write guard を実装する。
15. [x] V2 DB runtime write path を実装し、session / audit の新規書き込みを V2 schema へ対応させる。
16. [x] audit log 一覧 API を summary page / detail lazy load へ分割する。

## Design Gate

- 判定: repo-sync-required
- 理由: session / audit log / memory loading の IPC contract と UI 読込シーケンスを変更する可能性があり、MemoryGeneration / 独り言の削除・縮退は `docs/design/memory-architecture.md`、`docs/design/monologue-provider-policy.md`、`docs/design/audit-log.md`、`docs/design/database-schema.md` に影響する。

## 完了条件

- 起動・一覧表示系で巨大 JSON を不要に読まない経路が増えている。
- audit log は初期表示で重い詳細列を全件読まない。
- Memory Management は表示に必要な domain / page だけを取得する。
- MemoryGeneration / 独り言 / Memory prompt 注入の方針が実装と docs に一致している。
- 有益性が低い Memory 文脈が AI エージェント prompt に常設注入されない。
- 既存 DB を開ける互換性が保たれている。
- 検証結果と残リスクが `result.md` / `worklog.md` に記録されている。
