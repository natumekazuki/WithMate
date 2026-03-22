# Result

## Status

- 状態: 完了

## Completed

- cross-provider の capability matrix doc を追加した
- Codex / CopilotCLI / WithMate current を同じ表で追える状態にした
- 今後この doc を更新起点にするルールを明記した
- 関連 docs から参照できるようにした
- `README.md` に capability matrix の導線と更新ルールを追加した

## Remaining Issues

- Copilot 側は未確認項目がまだ多く、native support の実測で更新が必要
- capability 行の粒度は将来の provider 実装に合わせて調整が必要

## Related Commits

- なし

## Rollback Guide

- 戻し先候補: なし
- 理由: docs のみで commit 未作成のため

## Related Docs

- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/codex-capability-matrix.md`
- `docs/design/provider-adapter.md`
- `README.md`
