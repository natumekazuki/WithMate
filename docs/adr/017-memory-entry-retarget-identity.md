# ADR 017: Memory entryのretargetではentry identityを維持する

## Status

Accepted

## Context

Memory保守では、誤ったowner / scope targetへ保存されたentryを修正する経路が必要になる。実装案として、移動先へcopyして移動元をforgetする方式と、既存entryのtarget tupleを更新する方式を検討した。

entryはprotected file attachmentを所有でき、`supersedes`または`related` relationへ参加できる。copy-and-forgetではentry IDが変わり、relation endpoint、`superseded_by_id`、protected object owner、tag count、source / audit projectionを原子的に張り替える必要がある。不完全な張り替えは、外部から観測できるidentity分裂を残す。

## Decision

`memory.move_entry`はentry IDを維持し、一つのactive entryの解決済みowner / scope tupleを原子的に更新する。同じtransactionで、移動元tuple、移動先tuple、caller binding、request fingerprint、任意のidempotency keyを持つ専用move audit eventを記録する。

requestは、互いに異なる明示的な`from` / `to` targetを指定しなければならない。target不一致はnot foundへ畳み、existence oracleとして使えないようにする。idempotent replayではrequest fingerprintを再検証し、active entryが記録済みの移動先に残っていることを要求する。

## Alternatives

### Append at destination, then forget source

public entry IDが変わり、relationとprotected objectの張り替えが必要になるため採用しない。全関連状態を維持すると有用な履歴を増やさず操作だけが複雑になり、維持しなければ既存entry contractへ違反する。

### Direct target update without a dedicated audit record

durableなscope変更は初回appendやforgetと区別でき、idempotent replayを支えられる必要があるため採用しない。

## Consequences

- retarget後もentry ID、relation、protected-file attachment参照は安定する。
- moveはactive entryとrequestごとの一組の移動元 / 移動先に限定する。
- 後続moveが行われた場合、以前のmove replayは現在の成功として返らない。callerは現在targetを明示的に確認する必要がある。
- V6 schemaへadditiveな`memory_move_events_v6` tableを追加する。既存V6 databaseにはidempotentなschema ensure経路で追加する。
