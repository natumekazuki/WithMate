# Decisions

## Summary
- Characters は card 全体クリックで editor を開く。配色は装飾的なグラデーションよりも、淡い単色面と最小限のアクセントに寄せる。

## Decision Log

### 0001
- 日時: 2026-03-14
- 論点: Characters の編集導線を button のまま残すか card 全体クリックへ寄せるか
- 判断: `Edit` button は削除し、card 全体クリックで editor を開く
- 理由: Recent Sessions と同じ操作モデルにした方が Home の一貫性が高く、要素数も減るため
- 影響範囲: HomeApp, styles, Home docs

### 0002
- 日時: 2026-03-14
- 論点: Home の見た目を装飾的なグラデーションで押すか、配色をリセットするか
- 判断: 配色はフラット寄りに戻し、アクセントは border / shadow / 小さな色差に留める
- 理由: 現状のグラデーションは情報価値よりノイズが強く、プロダクト全体の基準色として弱いため
- 影響範囲: styles.css 全体のトークンと Home の panel / card 表現
