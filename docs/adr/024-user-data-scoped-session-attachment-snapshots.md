# ADR 024: Session attachment snapshotをuserData単位で所有する

- Status: Accepted
- Date: 2026-08-13

## Context

外部Session turnへ渡すSessionFolder attachmentは、provider実行中のpath差し替えから分離するため、OSのtemporary directoryへruntime-owned snapshotを作成する。前processが異常終了した場合は、次回起動時にorphan snapshotを回収する必要がある。

Electronのsingle-instance lockは`userData`を所有domainとする。一方、通常版、development、visual-checkなど異なる`userData`のWithMate instanceは同じOS temporary directoryを共有し、同時に起動できる。global prefixによるstartup cleanupでは、別instanceが使用中のsnapshotをorphanと区別できない。

## Decision

Session attachment snapshotは、正規化した`userData` pathのSHA-256 digestから導出するversioned namespaceへ保存する。path自体はnamespace名へ含めない。

startup cleanupはsingle-instance lock取得後に、現在の`userData`に対応するexact namespace直下だけを対象とする。createとcleanupは同じnamespace導出関数を使用する。namespace rootと各snapshot rootは、内容を書き込む前にcurrent OS userだけが利用できるpermissionへ収束させる。

旧global-prefix snapshotは所有者を証明できないため、新runtimeから削除しない。OSのtemporary-file cleanupへ委ねる。

## Alternatives

### OS temporary directory全体をprefixで走査する

異なる`userData`のactive instanceを区別できず、使用中のpersonal data snapshotを削除し得るため採用しない。

### PID、mtime TTL、heartbeatでactive leaseを判定する

PID再利用、suspend、clock skew、長時間provider実行が誤判定条件になる。現行のsingle-instance ownershipより複雑で、強い保証にならないため採用しない。

### snapshotをuserData配下へ置く

ownershipは明確になるが、一時データをapplication dataへ混在させ、異常終了時のtemporary cleanupという性質を弱めるため採用しない。

## Consequences

- 異なる`userData`の同時起動instanceは互いのactive snapshotを削除しない。
- 同じ`userData`ではsingle-instance lock holderだけが前process orphanを回収する。
- 同じ`userData`で複数processを許可する仕様へ変更する場合は、per-snapshot OS lockなど別のownership protocolを先に設計する必要がある。
- 旧global-prefix orphanは自動回収されない。
