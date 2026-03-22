# Result

## Status

- 状態: 完了

## Current Output

- Copilot stale connection 系 error では cached session / client を破棄して 1 回だけ自動再接続するようにした
- recovery 対象は `Connection is closed.` と `CLI server exited ... code 0` に限定し、partial result が出ている途中失敗は retry しないようにした
- stale connection 判定と retry 条件の回帰テストを追加した

## Remaining

- なし

## Related Commits

- なし
