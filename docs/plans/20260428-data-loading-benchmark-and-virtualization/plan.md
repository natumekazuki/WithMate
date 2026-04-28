# data loading benchmark and virtualization

## Status

進行中

## 背景

V2 DB 化と summary/detail 分離は進んだが、実データ規模で残るボトルネックが DB 読み込みなのか Renderer 描画なのかを定量化できていない。

## 目的

- 実データ相当の V2 DB を安全に生成できる benchmark data tool を用意する。
- session summary/detail、audit summary/detail の読み込み時間を測る。
- 計測結果をもとに Message / Audit UI virtualization の着手順を決める。

## スコープ

- repo 外または明示した出力先に synthetic V2 DB を生成する。
- V2 storage API 経由で主要 read path の benchmark を実行する。
- 結果を JSON と人間向け summary で出力できるようにする。
- 計測に必要な最小限の npm script / test を追加する。

## スコープ外

- 既存ユーザーデータの破壊的変更。
- 本番起動時の自動 migration。
- UI virtualization 本体の実装。
- 長期保持ポリシーの確定。

## チェックポイント

- [x] synthetic V2 DB 生成と benchmark 対象を設計する。
- [x] benchmark data tool を実装する。
- [x] tool の基本動作をテストする。
- [x] benchmark を実行し、次に着手する virtualization 対象を判断する。
- [x] 必要な検証を通す。
- [ ] 結果を記録して archive する。

## 中間結果

- `medium` profile（80 sessions / 9,600 messages / 2,000 audit logs / 24,281,088 bytes）では、V2 DB read path は概ね数 ms で完了した。
- `listSessionSummaries`: 約 2.4 ms
- `hydrateFirstSession`: 約 2.1 ms
- `hydrateMiddleSession`: 約 1.7 ms
- `auditSummaryFirstPage`: 約 2.5 ms
- `auditDetailFirstEntry`: 約 1.6 ms
- この結果から、次は DB read path より Renderer 側の Message / Audit UI virtualization を優先して確認する。
