# 002 Provider Turn Terminal and Cancellation

- 状態: Accepted
- 日付: 2026-07-13

## Context

Codex SDK の streaming API は terminal event を返した後も、transport の EOF または child process の終了待ちを継続する場合がある。WithMate が EOF を turn 完了条件として待つと、provider 側では turn が完了していても Session が `running` のまま残り、Cancel も収束しない。

同様に、provider が `AbortSignal` に応答しない場合や、turn 後の workspace snapshot が停止した場合も、UI と永続 Session の terminal 化が妨げられる。

## Decision

- provider SDK が定義する terminal event を turn outcome の正本とし、stream EOF は transport cleanup として扱う
- Codex では最初の `turn.completed`、`turn.failed`、fatal `error` を terminal event とし、それ以降の event は outcome に混ぜない
- terminal event 後の iterator close は bounded grace 内で行い、超過時は adapter-owned `AbortController` で SDK child process の停止を促す
- EOF が terminal event より先に到達した場合は protocol failure とし、取得済み partial result を保持する
- user cancel は composer / Character / Session / Audit を含む setup 全体で監視し、依存処理が停止しても bounded grace 後に呼び出しを収束させる
- canceled outcome を返した後も、停止中の setup または provider 処理が実際に終了するまでは terminating admission guard を維持し、同一 session / workspace / thread への再送を拒否する
- Audit Log は最小 terminal row を先に保存し、assistant text、operations、raw items、provider metadata などの詳細を bounded enrichment として後段で更新する
- turn 後の workspace snapshot は bounded enrichment とし、timeout 時は provider result を成功のまま返し、diff 不完全の metadata を残す

## Alternatives

- EOF を完了条件にする: transport cleanup が停止すると Session が terminal 化できないため採用しない
- terminal event で単純に `for await` を break する: implicit `iterator.return()` 自体を無期限に待つ可能性があるため採用しない
- turn 全体に固定 timeout を置く: 正常な長時間 turn まで中断するため採用しない
- `AbortSignal` だけに依存する: provider が signal 後も settle しない場合に Cancel が完了しないため採用しない
- cancel deadline で admission guard も解除する: 生存中の provider と再送turnが同じ workspace / threadへ副作用を起こし得るため採用しない
- Audit Log の詳細を一度の terminal 更新で保存する: 大きな enrichment の停止によって canonical row が `running` に残り得るため採用しない
- snapshot 完了を成功条件にする: 補助的な diff 生成が canonical provider outcome を妨げるため採用しない

## Consequences

### Positive

- provider が完了を通知した turn は transport EOF の停止に影響されず terminal 化できる
- setup 中の Cancel と abort 非協力 provider の両方で呼び出しは有限時間に収束し、生存中処理との再送競合も防げる
- Audit Log の詳細保存が停止しても canonical row は terminal phase を保持する
- snapshot timeout 時も assistant response と取得済み operation を失わない

### Negative

- terminal event 後に provider が送る非契約 event は取り込まない
- abort 非協力処理が終了するまでは Session が terminal 表示でも再送できない
- Audit enrichment timeout 時は terminal phase と最小情報だけが残り、詳細が不完全になる場合がある
- snapshot timeout 時は changed files / diff が不完全になる可能性があり、provider metadata と app log の確認が必要になる
- 強制収束後も provider 内部処理が遅れて終了する可能性があるため、late progress は runtime 側で無視し、実終了までは terminating guard を維持する必要がある
