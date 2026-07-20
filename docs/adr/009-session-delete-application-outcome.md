# ADR 009: Session deleteのApplication outcomeとcleanup failure timing

- Status: Accepted
- Date: 2026-07-18
- Session ID再利用防止の決定はADR 010によりsupersede

## Context

Session subtreeの削除はSQLite内のprimary deletionとSession Files cleanupを跨ぐ。ADR 001のmanifestによりcleanupは再開できるが、SQLite commit後のfilesystem failure、timeout、cancel、process停止を通常のwrite failureへ畳むと、削除済みのdomain valueを失い、callerが未commitと誤認する。反対に、manifestが残る状態をsuccessとすると、automationがSession Filesを含む完全削除と誤認する。

同じdeletion IDによるexact retryでは、root Session rowが既に存在しない場合にもworkspace bindingを復元し、元のSession IDとのfingerprint一致を検証する必要がある。別retryが並行してcleanupを完了すると、pendingを観測した直後のmanifest readが`not_found`になる競合もある。

## Decision

Session deleteは専用のApplication response unionを持つ。完全なsuccessは、全manifest itemのSession Files cleanupとcleanup完了commandが確認できた場合だけ返し、resultのcleanup statusを`completed`へ固定する。

primary deletionの有効なcommit結果を確認した後にcleanupが完了しない場合は、domain value、cleanup token、削除件数、local-only境界を保持した`partial_success`を返す。resultのcleanup statusは`pending`、issueはexact requestによる再照合を指示する単一のtyped cleanup issue、persistence statusはprimary deletionが確定済みであることを示す`committed`とする。filesystemや内部adapterのraw error、path、stackはissueへ投影しない。

primary deletion自体のtimeout、cancel、transport failureなどcommit結果を確認できない場合は、既存write failureの`effect=unknown`と`exact_request_required`を維持し、domain valueを推測しない。busyまたはfingerprint不一致によるRepository rejectionはDBとfilesystemを変更しないdomain failureとして扱う。

Application Serviceはdeletion IDだけの内部Repository readでpending/completedとworkspace bindingを取得する。状態が存在しない場合だけ対象Sessionからworkspace bindingを取得する。いずれの場合もprimary delete commandを元のSession IDと同じdeletion IDで再実行し、Repository fingerprintをexact retryの正本とする。Workspaceはpublic requestへ追加しない。

primary commit後は状態を再読し、completedならmanifestをpage取得せずsuccessへ収束する。pendingならbounded pageをordinal、件数、cursor、重複、omission、root Session包含について全件検証し、検証済みのSession Filesだけを逐次かつ冪等に削除する。manifestの`not_found`やcompletion競合では状態を再読し、completedならsuccess、それ以外はpartial successへ収束する。cleanup完了commandは全itemのcleanup後だけ送る。

Session IDはincarnation identityとして再利用しない。通常Session createとchild Session startの両入口はRepositoryが新しいIDを発行する。旧deleteのexact retryは削除時のIDだけを対象とし、新しいincarnationを変更しない。発行境界と削除後のcreate再送はADR 010を正本とする。

public field、validation上限、page projection、error codeの一覧はshared type、Application Service source、contract testを正本とする。

## Alternatives

- primary commit後のcleanup failureを通常のwrite failureにする: commit済みvalueとretry tokenを失い、未commitとの区別ができないため採用しない。
- manifestが残っていてもsuccessにする: Session Filesを含む完全削除とautomationが誤認するため採用しない。
- generic write partial successへcleanup issueを追加する: 他のwrite operationや`completed` resultとcleanup issueを不正に組み合わせられるため採用しない。
- CLI callerへWorkspaceを要求する: root row削除後のworkspace復元責務とfingerprint検証をcallerへ漏らすため採用しない。
- filesystem failure時にSQLite deletionをrollbackまたは復元する: DBとfilesystemを跨ぐatomic rollbackを保証できず、privacy境界とも衝突するため採用しない。

## Consequences

- callerはprimary deletionの確定とSession Files cleanup完了を別々に判定できる。
- exact retryはpending manifestを再開し、completed tombstoneでは同じfingerprintを検証してsuccessへ収束する。
- 新しいSession incarnationは削除済みIDを再利用しないため、旧delete retryが新しいSession Filesを削除しない。
- cleanupのtimeoutやfailureではmanifestが残り、Session rowを復元しない。
- Application responseの型がsuccess/completedとpartial/pendingを結合し、不正な組合せをcompile時に拒否する。
- local-only deleteはProvider側ThreadまたはSessionの削除を意味しない。

## Related decisions

- `docs/adr/001-session-subtree-delete-cleanup-manifest.md`
- `docs/adr/003-application-service-operation-envelope.md`
- `docs/adr/006-cli-session-control-plane.md`
- `docs/adr/010-repository-owned-session-incarnation-identity.md`
