# Plan

- 作成日: 2026-03-28
- タスク: 全機能の棚卸しとリファクタ対象の切り分け

## Goal

- current 実装の機能を大きい責務単位で整理する
- どこが密結合で、どこからリファクタすると効果が高いかを見える化する
- 今後の docs 精査より前に、実装リファクタの順序を固定する

## Scope

- `docs/design/` の current 設計と current 実装の責務整理
- Window / Session / Provider / Memory / Character / Settings / Persistence / Audit の機能マップ
- リファクタ優先順の設計

## Out Of Scope

- 実コードのリファクタ
- docs の削除整理
- backlog の大幅な再編

## Checks

1. current の主要機能が責務単位で一覧化されている
2. リファクタの優先順と目的が説明できる
3. docs 精査を後続に回す理由が明文化されている
