# Plan

- task: user feedback ベースで最適化ロードマップを再精査し、publish 前提の docs を整える
- date: 2026-04-13
- owner: Codex

## 目的

- `docs/optimization-roadmap.md` を user feedback ベースで再精査し、次の最適化 branch を切りやすい順序へ更新する
- 入力遅延、初期表示時の全データ読込、AuditLog の逐次可視化を roadmap 上の独立論点として整理する
- repo plan 一式を残し、docs publish 前の判断根拠を追跡できるようにする

## スコープ

- `docs/optimization-roadmap.md`
- `docs/plans/20260413-optimization-roadmap-refinement/`
- archived plan の参照にもとづく判断整理

## 非スコープ

- `src/` `src-electron/` のコード変更
- benchmark / profiler 基盤の追加
- `README.md` の導線変更

## 進め方

1. 既存 roadmap と archived plan を確認し、前回の候補分解と優先度を把握する
2. 指定された user feedback と確定根拠をもとに、候補一覧と実装順を見直す
3. repo plan の `decisions.md` `worklog.md` `result.md` へ今回の判断理由を残す
4. detached HEAD 前提の publish 準備として、branch 作成前に必要な注意点を明文化する

## チェックポイント

- [x] `docs/optimization-roadmap.md` に 9 件前後の候補が整理されている
- [x] Session input responsiveness が独立候補として追加されている
- [x] Session persistence summary/detail hydration と Session broadcast slimming に初期表示時の全データ読込観点が反映されている
- [x] Audit log live persistence が独立候補として追加され、observability / durability 改善を明記している
- [x] `questions.md` が `status: 質問なし` になっている
