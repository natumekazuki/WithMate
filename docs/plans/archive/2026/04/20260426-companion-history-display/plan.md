# Companion History Display 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

merge / discard 済みの CompanionSession を Home 上で read-only history として確認できるようにする。

## スコープ

- Home の Companion 一覧を active と history に分ける。
- active CompanionSession は従来どおり Review Window を開ける。
- merged / discarded / recovery-required は履歴カードとして表示し、Review Window は開かない。
- terminal status が UI 上で分かる label と updatedAt を表示する。
- 対象テストと design doc を更新する。

## 対象外

- `companion_merge_runs` table の追加。
- selected files summary / changed file summary の永続化。
- read-only Review Window の実装。
- sibling warning の DB 永続化。

## チェックポイント

1. [x] Companion session status 表示 helper を追加する。
2. [x] Home の Companion active / history 表示を分ける。
3. [x] storage / UI の対象テストを追加する。
4. [x] design doc を current 実装へ同期する。
5. [x] archive、commit。
