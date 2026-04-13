# 決定

## 2026-04-13

- current task は roadmap 文書化に限定し、実装や計測基盤の追加は行わない
- 最適化候補は `1機能 = 1 branch` で切れる粒度を優先する
- 候補数は、指定された論点を吸収できる 8 件で整理する
- `README.md` には最適化ロードマップへの導線だけを追加し、他の docs 整理は広げない
- roadmap 文書は `README.md` 直下ではなく `docs/optimization-roadmap.md` に置き、ルート README を人間向けの入口のまま保ちつつ、継続更新する判断材料は `docs/` 配下に集約する
- branch naming rule は `opt/<領域>-<機能名>` を採用し、最適化目的であることを接頭辞で即判別できるようにしつつ、責務境界と候補名の対応を branch 名で追いやすくする
