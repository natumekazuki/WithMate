# Worklog

## 2026-03-22

- `docs/design/coding-agent-capability-matrix.md` を基準に、Copilot 対応の rollout 順序を整理した
- capability ごとに follow-up task を切る方針を決めた
- Milestone A / B / C / Deferred の順で着手順を固定した
- follow-up task `20260322-copilot-basic-turn-execution` を切り、`基本 turn 実行` を完了した
- 実装の過程で `assistant text streaming` も同じ slice へ取り込み、Copilot でも current Session UI の live text 表示が通る状態にした

## 2026-03-23

- follow-up task `20260322-home-provider-selection-ui` を完了し、Home から `GitHub Copilot` provider を選んで session を作成できる状態にした
- follow-up task `20260323-copilot-cli-warning-suppression` を完了し、Copilot child CLI の warning を `code 0` false error にしない env workaround を入れた
- follow-up task `20260323-copilot-connection-recovery` を完了し、stale connection 系 error では cached session / client を破棄して 1 回だけ retry する recovery を入れた
- follow-up task `20260323-copilot-electron-runtime-debug` を完了し、Electron main process では native Copilot CLI binary を明示する bootstrap 修正を入れた
- follow-up task `20260323-copilot-command-visibility` を完了し、Copilot の `Latest Command` と audit `operations` で mutating tool も読めるようにした
- follow-up task `20260323-copilot-rawitems-filtering` を完了し、Copilot の `rawItemsJson` を stable event trace に圧縮した
- follow-up task `20260323-copilot-assistant-message-coalescing` を完了し、Copilot の複数 top-level assistant message を chat UI と audit で空行区切りに連結するようにした
- follow-up task `20260323-copilot-artifact-parity` を完了し、Copilot でも `Details` / `Open Diff` を出せる最小 artifact summary を組み立てるようにした
- `f6850da` `feat(copilot): add minimal provider integration` を作成し、Milestone A の初期 slice 群と launch UI まで main branch に入れた
- `2dd6b83` `fix(copilot): bootstrap native cli in electron` を作成し、Electron 実機で Copilot turn が通るところまで切り分けと修正を反映した
- `e772e69` `fix(copilot): normalize event handling` を作成し、Copilot の command 可視化、stable raw event trace、assistant message coalescing を main branch に入れた
- `8a644a0` `feat(copilot): add artifact parity` を作成し、Copilot でも `Details` / `Open Diff` を出せる最小 artifact summary を main branch に入れた

## 2026-03-24

- follow-up task `20260324-approval-ui-future-proofing` を完了し、Copilot `provider-controlled` の permission request を Session UI から `今回だけ許可 / 拒否` できるようにした
- follow-up task `20260324-copilot-approval-timeout-fix` を完了し、approval 後の長時間 command で `180000ms` 固定 timeout に落ちないよう turn 完了待機を event stream ベースへ切り替えた
- `93f5b27` `fix(copilot): handle approval requests in session ui` を作成し、approval UI と timeout fix を main branch に入れた
- follow-up task `20260324-copilot-file-folder-context` を完了し、Copilot でも file / folder を provider-native attachment として送れるようにした
- `4efd330` `feat(copilot): attach file and folder context` を作成し、file / folder context の follow-up task を main branch に入れた

## Next

- `image attachment` の Copilot native surface を current UI にどう載せるか整理する
- `custom agent selection` と `slash command absorption` の着手順を見直す
- `apps / mcp / plugins`、`sandbox / allowlist 拡張` は provider surface 確認後に follow-up task を切る
