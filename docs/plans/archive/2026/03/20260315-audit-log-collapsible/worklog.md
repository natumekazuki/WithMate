# Worklog

## Timeline

### 0001

- 日時: 2026-03-15
- チェックポイント: Plan 作成
- 実施内容: Audit Log の長文セクションをカテゴリ単位で折りたたむ方針を整理し、plan / decisions を作成した。
- 検証: 未実施
- メモ: 次は App.tsx の Audit Log 構造を `details/summary` ベースへ差し替える
- 関連コミット: 

### 0002

- 日時: 2026-03-15
- チェックポイント: Audit Log のカテゴリ折りたたみ実装
- 実施内容: `System Prompt` `Input Prompt` `Composed Prompt` `Response` `Operations` `Usage` `Error` `Raw Items` を `details/summary` ベースに置き換えた。summary の preview は持たせず、`Input Prompt` だけを初期 open にして、他は閉じた状態から読む形にした。関連 design doc と manual test checklist も更新した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: entry card 自体は展開したまま維持し、ユーザーが実際に何を送ったかを最初に確認できる構成に寄せた
- 関連コミット: `b6a4674` `feat(audit-log): collapse long sections by category`

## Open Items

- なし
