# Plan

- 作成日: 2026-03-27
- タスク: 現行 DB の定義書を作成する

## Goal

- WithMate の保存構造を 1 枚で把握できるようにする
- DB 内テーブルと DB 外保存の境界を明確にする
- 各テーブルの役割、主なカラム、JSON カラムの中身を読める形にする

## Scope

- `docs/design/database-schema.md` の新規作成
- 必要最小限の関連 design からの参照追加

## Out of Scope

- 実装変更
- migration 追加
- Project Memory の本実装

## Checks

1. 現在の保存先一覧がある
2. 各テーブルの主キー / 主なカラム / JSON カラムが分かる
3. `characters` が DB 外保存であることが分かる
4. current 実装テーブルと future design を区別して書いてある
