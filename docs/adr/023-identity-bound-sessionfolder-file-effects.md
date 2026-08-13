# ADR 023: SessionFolderのfile effectは検証済みdirectory identityへ固定する

## Status

Accepted

## Context

SessionFolderへのtranscript exportは、relative pathのcontainment検証後にtemporary fileへstreaming writeし、完成fileだけを公開する。検証後のabsolute pathをpublish時に再利用すると、parent directoryのsymlinkまたはjunctionを差し替える競合により、SessionFolder外へ出力できる可能性がある。publish直前の`realpath`再検証だけでは、その確認後からfile effectまでの競合を閉じられない。

同時に、process停止やresponse lossの後も、同じidempotency keyによる再試行で作成済みfileを識別し、別内容の既存fileを成功扱いしない必要がある。

## Decision

- containment検証で確定したparent directoryのfilesystem identityへworker processのcurrent working directoryを固定し、temporary file、publish proof、targetへのfile effectはbasenameだけで実行する。
- workerが固定したdirectory identityをMain Process側でも照合し、不一致または再確認不能ではpublishせずfail closedする。
- contentはworkerへstreaming転送し、hard maximumを超えた時点でtemporary fileを除去する。全量をMain Process memoryへ保持しない。
- publish前にdigest、byte length、file identityを永続化する。`replace=false`はhard link、`replace=true`はtemporary fileと同一identityのpublish proofを作成してからatomic renameし、response loss後の回復証拠を維持する。
- 完了またはterminal failure時は、temporary fileと同一identityであることを確認できたpublish proofだけを除去する。identityを証明できない既存fileは削除しない。

## Alternatives

### publish直前にabsolute pathを再検証する

再検証後からfile effectまでの差し替え競合が残るため採用しない。

### transcript全体をMain Process memoryへ保持して既存atomic write helperを使う

SessionFolder exportのresource limit契約と大容量streaming要件に反するため採用しない。

### native addonでdirectory handle相対操作を実装する

より直接的なOS primitiveを使えるが、platform別実装と配布負担が大きい。Node.jsの標準APIだけで必要なidentity固定とatomic publishを満たせるため、現時点では採用しない。

## Consequences

- path差し替え後もfile effectは検証済みdirectory identityから外れず、SessionFolder外へのpublishを防げる。
- worker processの起動と制御がexportごとに必要になる。
- Windowsではcurrent working directoryとして保持したparentのrenameが拒否される場合がある。この場合はpath変更としてfail closedする。
- durable completionまでtemporary fileまたはhard-link proofを保持するため、response loss後も同一fileを回復できる。
