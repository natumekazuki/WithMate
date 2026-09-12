# ADR 031: Work Itemの再開と移動で旧結果・判断を保持する

## 決定

Work Itemの再開は、新しいstable IDを持つsuccessorを作成する。Root Work ItemにはSlice 3で導入したsuccessor処理を再利用する。delegated Work Itemも同じ方針とし、predecessorのterminal state、result、execution association、aggregation decisionを新しい実行へ付け替えない。

同一IDのterminal rowをactiveに戻す方式では、child IDを参照する既存decisionとexecutionが新しい作業を参照してしまう。新ID方式は既存foreign keyとqueryの意味を保持し、sourceへの参照で目的の継続を表現できる。successorとcloneは新しい作成として既存の累積Work Item予算を消費し、同一要求のreplayだけを二重消費から除く。

moveは旧parentからの離脱、新parentへのadoption、必要な旧decisionのsupersedeを既存aggregation ownerの同一transactionで保存する。旧decisionの内容と所属履歴はeventとして残す。adoptionは所属の引受であり、成果の採用ではない。新parentが結果を使用するには別の明示的decisionが必要である。

2026-09-12のユーザー承認により、前倒しは上記moveに必要な内部処理、原子的保存、履歴再生、migration、直接検証に限定する。確定済み親結果または上位集約結果の訂正・stale伝播を要する移動はconflictとする。公開の汎用correction APIとflattenはSlice 5へ残す。successor分岐も旧branchの結果・判断・所属履歴を変えない場合に限る。

## 保存と認可の境界

actorはruntime binding、owner/root/parentはcanonical relationから取得する。契約のauthority説明はgrantではない。revision、idempotency、共通event header、budgetは既存ownerを使用し、migrationによる再baselineやgrant再発行で過去を置き換えない。

planned sourceは一つのtupleとして保存する。actual start sourceはcaller入力を採用せず、実行のadmissionでcanonical Workspaceから解決する。未取得のlegacy executionについて現在のGit状態を過去の開始地点として補わない。

archiveは一覧の可視性を変えるrevisionであり、resultやdecisionを書き換えない。restoreは可視性だけを復帰する。物理deleteはarchived terminalで、実行・親子・successor・集約の参照がないWork Itemに限定する。current rowを削除しても、監査と再送に必要な最後のsnapshot、typed event、共通header、期限内のidempotency responseを保持する。これは履歴を含む完全消去のAPIではない。

新しいlifecycle actionを既存baseline grantへ追加しない。既存grant ownerのtrusted内部発行で明示された範囲だけを付与し、Agent向けの汎用grant発行APIはSlice 7へ残す。

## 参照

- ADR 028: Root SessionのWork Item
- ADR 029: Session Runtimeの認可と履歴
- ADR 030: Root単位の資源予算
- `docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md`
