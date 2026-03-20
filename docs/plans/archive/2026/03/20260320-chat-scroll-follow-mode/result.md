# Result

## Status

- 状態: 完了

## Completed

- 条件付き scroll follow mode 用の新規 plan を作成した
- current baseline に合わせて、常時末尾追従・末尾付近閾値・step 更新範囲・新着あり導線・session 切替時 reset の方針を plan に反映した
- `src/App.tsx` に follow state / unread state / scroll signature を導入し、追従中のみ自動スクロールする実装へ置き換えた
- `src/styles.css` に `新着あり` / `読み返し中` の banner と `末尾へ移動` ボタンを追加した
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` を follow mode 前提で更新した
- 1件目のコミットとして `fix(session-window): 条件付き scroll follow mode を追加` を作成した

## Verification

- `npm run typecheck`: pass
- `npm run build`: pass
- review: 重大指摘なし
- review gap: 実機確認の軽微なテストギャップあり

## Remaining Issues

- 実機確認の軽微なテストギャップは残るが、重大指摘はなかった

## Related Commits

- `549687f64364a65c3ddd706a986cb97e6f5fbd04` / `fix(session-window): 条件付き scroll follow mode を追加`

## Rollback Guide

- 戻し先候補: `549687f64364a65c3ddd706a986cb97e6f5fbd04`
- 理由: 条件付き scroll follow mode 実装を戻す場合の基準点になるため

## Related Docs

- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
