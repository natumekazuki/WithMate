# ADR 001: Session subtree削除後のcleanup manifest

- Status: Accepted
- Date: 2026-07-14

## Context

Session subtreeの明示削除は、SQLite内の会話・実行データと、Application Serviceが管理するSession Filesの両方に影響する。SQLite commit後、応答送信前にprocess停止やtimeoutが起きると、削除済みSessionから対象IDを再導出できない。一方、削除対象ID群をcommand responseへ直接含めると、treeの大きさに応じてWorker response上限を超え、commit済みの結果を`effect=unknown`としてしか扱えなくなる。

削除済みSessionのtombstoneを残す案は、local明示削除でdomain rowを物理削除するprivacy境界と衝突する。Session Files削除をSQLite transactionへ含める案は、DBとfilesystemを跨ぐatomic commitを提供できない。

## Decision

Session subtreeのdomain rowはSQLite transaction内で物理削除し、Session tombstoneは保持しない。同じtransactionで、削除対象外の`session_deletion_manifests`と`session_deletion_items`へcleanup manifestを保存する。

呼び出し側は削除前にUUIDのdeletion IDを確定する。削除commandはこのIDをexact replay key兼cleanup tokenとして扱い、成功応答にはtoken、削除件数、local-only表示だけを返す。削除対象Session IDはboundedなpage readで取得する。

Application Serviceはpageを最後まで取得し、各Session Filesを冪等削除した後にcleanup完了commandを送る。cleanup完了前のcrashでは同じtokenから再開し、完了commandはmanifestとitemを削除する。Provider側データの削除はこのmanifestの対象に含めない。

workspace境界を越えるrelationを含むtreeは、manifest作成およびdomain mutationの前に拒否する。

## Alternatives

- 削除済みSession tombstoneへcleanup状態を保持する: 削除後もdomain identityを残し、物理削除の契約を弱めるため採用しない。
- Session ID群を成功応答だけで返す: response上限とcommit後の応答消失を安全に扱えないため採用しない。
- Session FilesをSQLite transaction中に削除する: filesystem失敗とDB rollbackを原子的にできず、write lock時間も外部I/Oへ依存するため採用しない。
- cleanup対象をprocess memoryだけに保持する: crash recoveryできないため採用しない。

## Consequences

- SQLite内のdomain削除とcleanup manifest作成は原子的になり、応答消失後も同じdeletion IDで結果を再取得できる。
- Worker responseはtree件数に依存せずboundedになる。
- filesystem cleanupはeventualかつ冪等であり、SQLite commit時点ではSession Filesが残る可能性がある。
- cleanup完了まで、削除済みSession IDとworkspace keyを含むmanifestがsubtree外に残る。Application Serviceはfiles削除より先にcleanup完了を記録してはならない。
- local-only境界は維持され、Provider側会話の削除や再試行は保証しない。
