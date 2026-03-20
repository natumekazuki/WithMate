# Worklog

## Timeline

### 0001

- 日時: 2026-03-20
- チェックポイント: Plan 作成
- 実施内容: pending indicator 周辺の user-facing copy を WithMate のキャラ体験へ寄せる局所 task として、新規 repo plan を作成した。Goal / Scope / Out of Scope / Copy Policy / Validation と same-plan/new-plan 判定を整理し、`src/App.tsx` と docs の同期方針を定めた
- 検証: 文書作成のみ
- メモ: 実装は未着手。次工程では exact copy 候補、character 名未取得時の degrade、screen reader 文言同期、必要時のみ CSS 調整を確認する
- 関連コミット:

### 0002

- 日時: 2026-03-20
- チェックポイント: Copy 実装と docs sync
- 実施内容: `src/App.tsx` の pending indicator visible text / screen reader text を character 名ベースへ更新した。`resolvedCharacter.name` または session snapshot の character 名を優先して `<キャラ名>が作業を進めています` / `<キャラ名>が返答を続けています` / `<キャラ名>が返答を準備しています` を出し、名前が取れない場合は `作業を進めています` / `返答を続けています` / `返答を準備しています` へ degrade するようにした。長い character 名で pending bubble が崩れにくいよう `src/styles.css` に局所的な折り返し保護を入れ、`docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` を実装方針へ同期した
- 検証: `npm run typecheck`、`npm run build`
- メモ: state / type / provider などの system 用語、scroll follow banner、pending indicator の表示条件や runState 制御は変更していない
- 関連コミット:

## Open Items

- 実機で長い character 名を使った pending bubble の見え方と、screen reader 相当環境での通知量を最終確認する
