# 20260416 model-depth-switch-bug Decisions

## Decision 1

- 日付: 2026-04-16
- 内容: Session の model 切り替えでは、切り替え先 model に current depth が無い場合でも切り替え失敗にせず、provider default depth、それも無ければ selected model の先頭 depth に fallback する。
- 理由: Session UI の model select は有効な model だけを選ばせる一方、current depth は直前 model の値を保持しているため、そのまま strict validation に通すと model change 自体が失敗するため。

## Decision 2

- 日付: 2026-04-16
- 内容: Depth を直接切り替える操作は従来どおり strict validation のまま維持する。
- 理由: Depth UI は selected model の対応候補だけを表示しており、ここで fallback を混ぜる必要がないため。

## Decision 3

- 日付: 2026-04-16
- 内容: 回帰 test は `scripts/tests/model-catalog-settings.test.ts` に追加する。
- 理由: 今回の差分は model catalog の解決規約に近く、helper 単位で fallback の意図を固定するのが最小で分かりやすいため。
