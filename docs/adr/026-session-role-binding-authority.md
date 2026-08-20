# ADR 026: 通常SessionのRoleと親子関係をimmutable bindingとして所有する

## Status

Accepted

## Context

AgentがSessionを子として作成するには、callerが申告したparentやprompt上の指示ではなく、provider executionに結び付いたactor Sessionから作成権限を判定する必要がある。GUIのroot作成とAgent向けchild作成が別々にRoleを決めると、保存済みSession、runtime binding、public projection、Turn promptの間でauthorityがずれる。

RoleだけをSessionへ追加しても、root、parent、depthを別々に更新できれば親子関係の意味を維持できない。既存Sessionの移行、idempotent replay、削除も同じtupleを前提に扱う必要がある。

## Decision

- 通常Sessionは`sessionRole`、`roleContractRevision`、`rootSessionId`、`parentSessionId`、`delegationDepth`を一つのimmutable bindingとして永続化する。revisionは`1`、最大depthは`2`とする。
- Roleは`standalone`、`overall-coordinator`、`task-coordinator`、`executor`の閉じた列挙とする。rootは前二者、childは後二者だけを使う。
- root bindingは`parentSessionId = null`、`rootSessionId = sessionId`、`delegationDepth = 0`とする。child bindingのparentはruntime bindingのactor Session、rootはparentから継承し、depthはparentに1を加えた値とする。requestからparent、root、depth、Character identityを受け取らない。
- child作成は`overall-coordinator`から`task-coordinator`または`executor`、`task-coordinator`から`executor`だけを許可する。`standalone`と`executor`はchildを作成できない。
- GUIはroot用途を左から`standalone`、`overall-coordinator`の順で選択し、既定を`standalone`とする。GUIからchild Roleは作成しない。
- Session rowとRole bindingは同じtransactionで作成する。既存の通常Sessionは一度だけ`standalone` rootへ移行する。現行schemaのbinding欠落、未知Role、unsupported revision、壊れたtupleは読み替えず拒否する。`character-authoring`、Auxiliary、退役済みCompanionへ通常Session bindingを流用しない。
- `session.create`のidempotency scopeはactor Sessionをprincipalに含める。fingerprintはactor、requested child Role、導出binding、既存create入力を含む。canonical replayはcurrent parentとcatalogの再検証より先に判定する。
- `session.self`、`session.create`、`session.list`、`session.get`は同じ5 fieldを公開する。runtime catalogはrevision、Role、child規則、最大depthを公開する。opaque binding reference、hash、operation grant、private Character snapshotは公開しない。
- provider execution generationのauthority snapshotと通常Session Turnの専用System Prompt sectionは、保存済みcanonical bindingを使う。同一generationのretryは同じsnapshotを維持し、generation再作成時はcurrent bindingから発行する。
- rename、provider option変更、通常のSession updateはbindingを保持し、入力tupleが保存済みtupleと異なる場合は拒否する。
- childを持つSessionの単体削除は副作用前に拒否する。一括削除は走査開始時点でchildを持つSessionを除外し、同じ走査中にleaf削除後のparentを追加しない。

## Consequences

- GUI root作成とAgent child作成は同じbinding contractへ収束する。
- actor authorityはrequest bodyやpromptの自由文に依存しない。
- Role bindingが壊れた通常Sessionはprovider executionを開始できず、修復なしにstandaloneへ降格しない。
- 親子参照を持つため、削除時はchild保護を判定した後、bindingを深い順に削除してから既存のSession cleanupを完了する。
- 実provider accountを使うend-to-end確認は別途必要だが、binding発行、prompt、schema、CLI、MCP、HTTPの一致はaccount不要のcontract testで検証できる。

## Alternatives

### Role、parent、root、depthをrequestへ含める

callerがauthorityと親子関係を自己申告できるため採用しない。

### RoleだけをSession rowへ保存する

親子関係とdepthを別の入力や推測へ依存させ、idempotency、削除、runtime snapshotの不変条件を一つのownerで検証できないため採用しない。

### 既存Sessionの不正bindingをstandaloneへ読み替える

破損や未対応revisionを権限縮小に見せかけ、永続状態と実行authorityの不一致を隠すため採用しない。

## References

- ADR 021: Agent runtime bindingはgeneric authority snapshotとして所有する
- `docs/design/session-external-runtime.md`
- `docs/runbooks/session-cli.md`
