# Decisions

## D-001: plan tier

- 日付: 2026-04-27
- 決定: repo plan として管理する。
- 理由: データ読み込み経路、IPC、UI、設計書にまたがる変更であり、MemoryGeneration / 独り言機能の削除可否についてユーザー確認が必要なため。

## D-002: Design Gate

- 日付: 2026-04-27
- 決定: repo-sync-required とする。
- 理由: Memory / monologue / audit log / database schema の現行仕様に影響する可能性があるため。

## D-003: MemoryGeneration / 独り言の削除方針

- 日付: 2026-04-27
- 決定: MemoryGeneration と独り言機能はいったん削除する。`Session Memory` / `Project Memory` の AI エージェント prompt 注入も停止する。
- 理由: 過去 prompt の評価で Memory section が input body の大半を占める一方、有益な文脈として機能している確信が弱く、トークン効率を悪化させている可能性が高いため。独り言も出力の面白味が薄く、再実装する場合は詳細設計から作り直すほうがよいため。

## D-004: 既存 DB データの扱い

- 日付: 2026-04-27
- 決定: 既存 DB の Memory / monologue / background audit log は migration で削除しない。
- 理由: 今回は機能・自動実行・prompt 注入・UI 導線の削除を目的とし、既存データ破壊は不要かつ復旧不能な副作用になるため。
