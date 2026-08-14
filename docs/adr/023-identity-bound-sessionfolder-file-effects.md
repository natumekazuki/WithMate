# ADR 023: SessionFolderのfile effectは検証済みdirectory identityへ固定する

## Status

Accepted

## Context

SessionFolderへのtranscript exportは、relative pathのcontainment検証後にtemporary fileへstreaming writeし、完成fileだけを公開する。検証後のabsolute pathをpublish時に再利用すると、parent directoryのsymlinkまたはjunctionを差し替える競合により、SessionFolder外へ出力できる可能性がある。publish直前の`realpath`再検証だけでは、その確認後からfile effectまでの競合を閉じられない。

同時に、process停止やresponse lossの後も、同じidempotency keyによる再試行で作成済みfileを識別し、別内容の既存fileを成功扱いしない必要がある。

## Decision

- containment検証で確定したparent directoryのfilesystem identityへworker processのcurrent working directoryを固定し、temporary file、publish proof、targetへのfile effectはbasenameだけで実行する。
- workerが固定したdirectory identityをMain Process側でも照合し、不一致または再確認不能ではpublishせずfail closedする。
- contentはworkerへstreaming転送し、hard maximumを超えた時点で失敗させる。全量をMain Process memoryへ保持しない。
- publish前にdigest、byte length、file identityを永続化する。新規targetはtemporary fileからno-overwrite hard linkで公開し、response loss後の回復証拠を維持する。
- Node.jsのpath-based `rename` / `unlink`では検証後の同名file差し替えを閉じられない。Windows版v6.4では既存targetへの`replace=true`を副作用前にfail closedとし、operation-owned temporary fileとpublish proofは自動削除しない。
- 既存targetの安全な置換とproof cleanupは、file handleへ結び付いたno-replace move / delete primitiveを導入した後に有効化する。

## Alternatives

### publish直前にabsolute pathを再検証する

再検証後からfile effectまでの差し替え競合が残るため採用しない。

### transcript全体をMain Process memoryへ保持して既存atomic write helperを使う

SessionFolder exportのresource limit契約と大容量streaming要件に反するため採用しない。

### native addonでdirectory handle相対操作を実装する

既存targetの安全な置換とproof cleanupを直接実現できる。一方でplatform別実装と配布検証が必要なためv6.4には含めず、該当操作をfail closedにする。

## Consequences

- path差し替え後もfile effectは検証済みdirectory identityから外れず、SessionFolder外へのpublishを防げる。
- worker processの起動と制御がexportごとに必要になる。
- Windowsではcurrent working directoryとして保持したparentのrenameが拒否される場合がある。この場合はpath変更としてfail closedする。
- durable completion後もtemporary fileまたはhard-link proofを保持するため、response loss後も同一fileを回復できる。成功時のhard linkはtargetと同じfile contentを共有するが、directory entryは残る。
- limit超過などpublish前の失敗でもpartial temporary fileが残り得る。第三者fileの削除より安全側へ倒した既知の運用上の制約であり、native cleanup primitiveの導入時に解消する。
