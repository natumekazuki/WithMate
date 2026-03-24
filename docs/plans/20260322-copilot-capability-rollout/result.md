# Result

## Status

- 状態: 進行中

## Current Output

- Copilot 対応 capability の rollout plan を作成した
- Milestone A / B / C の順で slice を定義した
- 最初の follow-up task を `基本 turn 実行` に固定した
- `基本 turn 実行` slice は完了し、Copilot minimal runtime が main branch 作業ツリーに入った
- Home の `New Session` から `GitHub Copilot` provider を選んで session を作成できるようにした
- Copilot child CLI warning 抑止と stale connection recovery を入れて、known false error への対策を積んだ
- Electron main process では native Copilot CLI binary を明示するようにし、Copilot turn が実機でも通る状態にした
- Copilot `provider-controlled` の permission request を Session UI の pending bubble から `今回だけ許可 / 拒否` できるようにした
- approval 後の turn 完了待機を event stream ベースへ切り替え、長時間 command で false timeout しないようにした

## Remaining

- capability ごとの follow-up plan 作成
- `file / folder context` の Copilot native input 反映
- `image attachment` の native surface 確認
- `custom agent selection` と `slash command absorption` の実装設計
- `apps / mcp / plugins`、`sandbox / allowlist 拡張` の provider surface 調査

## Related Commits

- `f6850da` `feat(copilot): add minimal provider integration`
- `2dd6b83` `fix(copilot): bootstrap native cli in electron`
- `e772e69` `fix(copilot): normalize event handling`
- `8a644a0` `feat(copilot): add artifact parity`
- `93f5b27` `fix(copilot): handle approval requests in session ui`

## Related Docs

- `docs/design/coding-agent-capability-matrix.md`
