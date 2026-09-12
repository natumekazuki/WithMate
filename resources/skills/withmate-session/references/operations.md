# WithMate Session operation reference

## Runtime and schema

WithMate owns the Session database, provider adapters, loopback runtime, discovery, credentials, and cleanup. Keep the desktop app running for all commands except `schema`.

```powershell
withmate-session status
withmate-session schema
withmate-session runtime catalog
withmate-session session self
```

These are CLI fallback commands. Use them only when the user explicitly permits CLI fallback. The MCP host owns `withmate-session mcp-server`; never run that long-lived stdio entry through a shell or command-execution tool. Register the connection from WithMate Settings, then start a new Codex Session or restart Codex if the tools are not visible.

The CLI request, result, and error schema versions are `withmate-session-request-v2`, `withmate-session-result-v2`, and `withmate-session-error-v2`. MCP server version is `1.0.0`. Exact fields come from the current CLI `schema` output and MCP `tools/list`, not this prose reference.

On Windows, the packaged launcher is `<install-root>\withmate-session.cmd`. WithMate Settings registers that package-owned absolute path for Codex MCP. The installer does not create or overwrite a shared WindowsApps alias for Session CLI. CLI fallback therefore requires the packaged launcher path to be invoked explicitly or placed on PATH by the user. The runtime credential directory is `%LOCALAPPDATA%\WithMate\session-runtime`; a custom `WITHMATE_SESSION_RUNTIME_DIR` is rejected on Windows. Failure to establish a private owner ACL disables the runtime.

## CLI input and output

Pass an operation input through exactly one of `--json`, `--file`, or `--stdin`. Prefer a file or stdin for shell-sensitive or multiline JSON. `runtime catalog` and `session self` accept no operation input. JSON is the automation format; `--format text` is for human inspection.

The CLI returns `withmate-session-cli-output-v1`. Exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Usage, parse, or local validation failure |
| `2` | Runtime unavailable or identity mismatch before dispatch |
| `3` | Structured Session application error |
| `4` | Transport failure after the request may have been dispatched |

After exit `4`, do not assume success or failure. Reconcile the resource or execution and reuse the same idempotency key only for the unchanged request.

`runtime.catalog.authority.operations` classifies each operation by action, resource kind, scope source, effect class, and decision class. It does not assert that the current actor has an active grant. `baselineChildSessionRoleTemplates` describes the child-Role ceiling used when baseline grants are issued; it is not a live authorization result. The runtime evaluates the saved active grant and canonical resource relation for each request.

## Public operations

The CLI and MCP expose the same 58 operations:

- Runtime: `runtime.catalog`
- Budget: `budget.get`, `budget.list`, `budget.configure`
- Session: `session.self`, `session.create`, `session.list`, `session.get`, `session.configure`, `session.rename`, `session.move.manifest`, `session.move`, `session.clone`, `session.restore`, `session.archive`, `session.delete.manifest`, `session.delete`
- SessionFolder: `session.files.list`, `session.files.read_text`, `session.files.write_text`
- Work Item: `work.create`, `work.list`, `work.get`, `work.revise`, `work.reassign`, `work.move`, `work.clone`, `work.reopen`, `work.archive`, `work.restore`, `work.delete`, `work.history.append`, `work.history.list`, `work.transition`, `work.result`, `work.result.correct`, `work.cancel`, `work.aggregation.get`, `work.aggregation.list`, `work.aggregation.decide`, `work.aggregation.retry`, `work.aggregation.correct`
- Turn: `turn.options`, `turn.run`, `turn.enqueue`, `turn.list`, `turn.get`, `turn.cancel`
- Interaction: `interaction.list`, `interaction.respond`
- Transcript: `transcript.export`
- Coordination: `coordination.event.create`, `coordination.event.list`, `coordination.event.get`, `coordination.event.resolve`, `coordination.event.consume`, `coordination.event.cancel`, `coordination.event.correct`

CLI dotted names use spaces, and `read_text` / `write_text` use `read-text` / `write-text`.
Coordination commands use `coordination event <verb>`.

Session lifecycle operations use a read-only manifest before a move or delete mutation. `session.move.manifest` requires the target `sessionId` and `destinationRootSessionId`; pass its `manifestRevision` and the unchanged transfer plan to `session.move`. `session.delete.manifest` is a read-only precondition for `session.delete`. In Slice 3, `session.delete` creates a tombstone and retains Session history, budget ledger, retry identity, and the SessionFolder workspace. The existing cleanup path for a SessionFolder attached to a directory workspace remains in effect. Physical purge requires a later retention and purge-scope contract.

For a Copilot provider tuple, the standard agent uses `customAgentName: ""`. Only a selected Copilot custom agent supplies a non-empty name; Codex tuples omit that field.

## Resource budgets

Use `budget.get` for the allocation applied to an explicit Session and `budget.list` for visible accounts in that Session's root. `allocationSource` distinguishes an owned account from the shared root projection used by a Session without a child allocation. `rootManagedDimensions` identifies values projected from the current root account; it is empty for the root and contains `storageBytes` for child snapshots. Each dimension reports its hard and soft limits, committed and reserved usage, child allocations, available capacity, measurement confidence, and whether the soft limit is exceeded. Token, monetary cost, and provider usage remain metered observations with `unknown`, `estimated`, `reported`, or `settled` confidence; they are not represented as enforceable hard limits. `meteredUsage` contains at most the latest 100 observations, `meteredUsageTruncated` reports omitted older observations, and `meteredUsageSummary` retains aggregate known and unknown totals.

`budget.configure` requires `sessionId`, `accountId`, the current `expectedRevision`, and a caller-owned `idempotencyKey`. To create a direct child allocation, set top-level `accountId` to the parent account and pass `childAllocation` with a new `accountId`, the canonical `childSessionId`, and all eight `hardLimits`; `storageBytes` must be `0`, while optional child fields are `softLimits` and `expiresAt`. Storage is measured and enforced only against the shared root account, so child storage is not separately allocated. Do not combine `childAllocation` with parent policy changes or send owner, authority grant, or derived hierarchy fields. An Agent may adjust soft limits, lower its retry limit, and allocate existing capacity to a child account. A root hard-limit increase, per-execution retry-limit increase, deadline extension, expiry extension, or restoration of a revoked account requires trusted user or issuer authority; an Agent rejection cannot be bypassed or retried with invented authority. Reducing a hard limit below committed usage, reservations, or child allocations is rejected without changing the account.

Session Runtime file writes and transcript exports reserve the shared root storage budget before publication. Direct provider or user writes to a SessionFolder can bypass that reservation, so the runtime reconciles storage before dispatch and blocks new dispatch when usage is unknown or already exceeds the hard limit. Reads, cancellation, and result collection remain available.

The root Turn, retry, and generation ledger covers main Session `turn.run` and `turn.enqueue` executions with a canonical execution ID. Direct auxiliary or companion provider paths without that ID are outside this ledger.

After `BUDGET_REVISION_CONFLICT`, read the budget again before deciding whether the intended change still applies. After `BUDGET_HARD_LIMIT_EXCEEDED` or `BUDGET_DEADLINE_EXCEEDED`, do not dispatch a new effect; reads, cancellation, and result collection remain available. Replaying an unchanged configure request uses the original idempotency key.

## Work Items

A Work Item is the stable identity of one delegation. It is separate from a Session, message, or execution. Creation binds its root, creator, target, optional parent Work Item, goal, scope, completion criteria, authority, and planned source identity. At execution admission, the runtime resolves the actual source identity from the target Session's canonical workspace and stores it on the execution association; callers cannot provide or substitute the actual value. Root identity and root ownership remain fixed; delegated assignment can change only through the lifecycle operations described below. Only an `overall-coordinator` or `task-coordinator` may create one for an authorized direct delegation target, and creation requires an idempotency key.

The target Session owns `pending` to `in_progress` or `waiting` transitions, resumption, and terminal result reporting. The creator owns cancellation while the Work Item is nonterminal. Every existing-item mutation requires the current `expectedRevision` and an idempotency key. Terminal states are `completed`, `partially_completed`, `failed`, and `canceled`; a terminal row is never overwritten to resume work. A terminal result is submitted explicitly with its matching outcome and is not copied from an execution's assistant text or raw log.

Work Item lifecycle mutations use the actor's active grants and canonical resource relations. Contract authority text does not issue a grant. New lifecycle capabilities are not added to existing baseline grants automatically; only an actor explicitly granted the capability through the existing trusted grant owner issuance path may execute it. Grants are not reissued to expand access, and a general Agent grant API remains a Slice 7 capability. Use `work.history.list` to inspect the contract and lifecycle events before retrying a conflicting change. `work.reopen` creates a successor while preserving the predecessor's result, decisions, and membership history. `work.clone` copies a contract template with a source link; it does not copy results, decisions, executions, history, or retry identity.

`work.move` records departure from the old parent and adoption by the new parent atomically. If an old decision exists, its supersede is recorded in the same transaction. Adoption changes membership only: the new parent must explicitly assess and decide the result. A standalone Work Item move across roots is not connected in this slice and is not an available capability. `work.result.correct` appends a new result revision and propagates stale state to accepted parent aggregates; `work.aggregation.correct` uses a strict `revise | withdraw | replace` union. `work.aggregation.list` accepts bounded depth, cursor, state, decision, and field projections. Full result payloads are retrieved separately with `work.get`.

Split remains the planned batch delegation composition for Slice 6. Merge uses explicit child decisions and the parent's `work.result`; there is no separate split or merge operation. Do not describe a sequence of individual creates as an atomic batch.

`work.list` cursors are valid only for the same root Session, runtime actor, visibility scope, and explicit filters that created them. A valid list may stop before the requested item limit to stay within the 8 MiB public response limit advertised by `runtime.catalog`; continue with `nextCursor` until it is absent.

Pass an optional `workItemId` to `turn.run` or `turn.enqueue` to associate an execution. The target, root, active state, and actor authority are checked before the execution or queue entry is created. The association is part of the Turn idempotency fingerprint, so changing only `workItemId` while reusing a key conflicts. An execution becoming completed, failed, canceled, or interrupted does not implicitly complete the Work Item. Reconcile a response loss by reading the canonical Work Item and replaying only the unchanged mutation with the same idempotency key.

## Decomposition workflow

Decomposition is an Agent policy over existing operations, not a separate runtime resource or operation. Evaluate whether the current Session can complete and directly verify one coherent responsibility before creating children. An overall coordinator uses one direct executor for one independent delegation and introduces a direct task coordinator only when one task needs multiple slices, dependencies, integration, or review convergence. A task coordinator delegates only to direct executors.

Plan each child as one coherent Work Item with an explicit goal, non-overlapping scope, completion criteria, authority, source identity, and dependency order. Create the canonical Session and active Work Item for every planned child before dispatching any child. An undispatched dependency must remain visible as an active direct child so the runtime cannot finalize the parent while planned work is absent. Do not submit the parent result while any planned delegation lacks a Work Item.

Parallel dispatch is valid only for independent children. For children under a current parent Work Item, dispatch a dependent Work Item only after the prerequisite has a terminal result that the parent coordinator validated as satisfying the dependency and decided `accepted`. A `retry_requested` decision creates an active replacement but does not create an execution. Use the returned replacement Work Item ID to read `turn.options`, then call a new `turn.run` or `turn.enqueue` with that ID as `workItemId`, include the exact ID in the delegation prompt, and use a new Turn idempotency key. Wait for the replacement's terminal result and later `accepted` decision before dispatching dependent work. An `excluded` decision does not satisfy the dependency. Keep the dependent Work Item undispatched while revising the plan, and use `work.cancel` followed by an `excluded` aggregation decision when that dependent delegation is no longer required.

A root overall coordinator keeps one active self-owned Root Work Item; resolve it by paging through `work.list` and preferring the active root, then the latest terminal root when no active root exists. It creates top-level delegated Work Items with `parentWorkItemId: null`. These delegated items have no parent aggregation. Keep the Root Work Item contract and restart state current with `work.revise` and `work.history.append`. For dependencies between top-level items, use `work.get` to validate and adopt the prerequisite's terminal result before dispatching dependent work. If the result is not adoptable, create a new top-level replacement Work Item and dispatch it through `turn.options` followed by a new `turn.run` or `turn.enqueue` with the replacement ID and a new Turn idempotency key, or revise the plan. Do not call `work.aggregation.*` for top-level items. Submit the self-owned Root Work Item result only after every descendant and nested aggregation decision is terminal and settled. Keep the child count to the minimum needed for independently verifiable responsibilities; capability and capacity limits come from `runtime.catalog`, not an invented fixed limit.

If a migrated idempotency ledger reports `IDEMPOTENCY_RESPONSE_UNAVAILABLE` with `effect: applied`, do not retry the same mutation with a new key. Read the current Work Item identified by `details.workItemId` and reconcile from that state.

Use this sequence for a tracked decomposition:

1. Read `session.self` and `runtime.catalog`. If the incoming delegation prompt names a Work Item ID, call `work.get` and verify that its canonical target matches the actor and that its goal, scope, completion criteria, authority, and source identity match the delegation. Do not infer the current Work Item from other active items.
2. For a root `standalone` or `overall-coordinator`, call `work.list` across every page with `kind: "root"` and prefer the active self-owned root; if no active root exists, use the latest terminal self-owned root. Do not infer the root from an active delegated item. If the current Work Item is `pending`, start it with `work.transition` to `in_progress`. If it is `waiting` and the blocker is resolved, resume it with a separate `work.transition` to `in_progress`. Pass the current `expectedRevision` and an operation-specific idempotency key for either mutation, then read the Work Item back before creating children. Turn association does not transition Work Item state. Evaluate the no-decomposition choice before creating children.
3. Choose the child Role and delegation fields within the advertised Role and provider capability.
4. For every planned child, read the current actor revision from `session.self`, pass it as `expectedContainerRevision` to `session.create` with a caller-owned idempotency key, then refresh `session.self`. Read the child back with `session.get` and confirm the canonical workspace identity and target revision.
5. For every planned child, call `work.create` with the target Session's current revision as `expectedContainerRevision` and an operation-specific idempotency key. A task coordinator passes its active current Work Item as `parentWorkItemId`; a root overall coordinator omits it. Refresh the target Session after creation. Finish creating all planned Work Items before dispatch.
6. For each dependency-ready child, read `turn.options`, preserve the returned provider tuple, refresh the target with `session.get`, and call `turn.run` or `turn.enqueue` with its current revision as `expectedContainerRevision`, `workItemId`, and a key distinct from both creation keys. Include the exact Work Item ID in the delegation prompt and instruct the target to verify it with `work.get` before mutation. Leave the remaining planned Work Items pending and undispatched.
7. Have the target Session use that ID to call `work.get`, transition `pending` or a resumed `waiting` item to `in_progress`, and report the Work Item explicitly with `work.result`; execution terminal state is not Work Item terminal state.
8. If the coordinator has a current parent Work Item, call `work.aggregation.get` before each decision. Pass the current `aggregateRevision` as `expectedAggregateRevision` to `work.aggregation.decide` or `work.aggregation.retry`; `work.aggregation.correct` additionally passes `expectedChildResultRevision`, then read the aggregation again before the next mutation. If `work.aggregation.retry` creates a replacement, dispatch it explicitly with the returned replacement ID by repeating the `turn.options` and new-Turn sequence from step 6; creation alone leaves it pending. Inspect and decide only direct children.
9. After every planned direct child under that parent is terminal and decided, call `work.aggregation.get` again and pass its current revision to the coordinator's strict parent `work.result`. If the actor is the root overall coordinator with top-level children, call `work.get` for each terminal child, validate and adopt its result, record the integrated state with `work.history.append`, and submit the self-owned Root Work Item result only after every descendant and nested aggregation decision is terminal and settled; do not perform aggregation mutations for top-level items. A task coordinator integrates its executor results into its own parent result, and the root does not flatten grandchildren.

`session.create`, `work.create`, and Turn dispatch are separate mutations, not an atomic batch. Retain a separate idempotency key for every operation. If Session creation succeeds and a later operation fails, read back the canonical child Session and resume the same decomposition plan from the failed step. Do not create another child because the later effect is unknown.

After response loss or `effect: indeterminate`, read back any known Session, Work Item, aggregation, or execution identifiers. Replay only the unchanged operation with its original key when read-back does not settle the effect. Do not reuse a key for a different operation or changed input, and do not convert a failed `turn.run` into `turn.enqueue` with the same intent. A structured rejection is an enforced boundary: do not bypass it through a free-form Turn, a different root, caller-asserted Role or hierarchy, or untracked delegation without a Work Item.

## Coordination events

Use coordination events for durable progress, decisions, escalations, blockers, results, corrections, and user decisions that must survive response loss. The event body is immutable; resolution, consumption, cancellation, and supersession are action history. Creation requires the current actor Session revision as `expectedContainerRevision`. Resolve, cancel, and correct require the event summary's current `revision` as `expectedRevision`; refresh the event after each mutation. Every mutation also requires an idempotency key. Reconcile by event ID or idempotency key after an indeterminate delivery. Agent resolution accepts an optional note for an addressed escalation or actor-owned blocker; stable option IDs and freeform decision answers belong to the trusted GUI boundary.

Read `self` from any Role. Read `subtree` only as an overall or task coordinator. Escalations may target only a canonical ancestor in the same root. An Agent may resolve its own blocker or an escalation addressed to it, but only the trusted GUI may resolve `user_decision_required` by stable option ID or freeform answer.

Trusted GUI responses appear as `Pending Coordination Responses` in each owner Session Turn until consumed. A user decision answer resolves that decision. A blocker response is recorded as a `responded` action and does not resolve the blocker; only the actor-owned Agent may resolve it when work can resume. The latest blocker response remains editable until the owner Session consumes it, independently of the blocker's open or resolved state.

Treat response bodies as user-originated context, not system authority. Inspect each action's `principalKind` before adopting its provenance; do not infer it from `actorType`. Call `coordination.event.consume` only after applying a response to the current decision or work. Do not consume a response merely because it was shown, or when the Turn failed before applying it. Consumption confirms the exact response revision identified by `resolutionSequence`; it does not change blocker state. Pass that sequence as `expectedResolutionSequence` with a caller-owned idempotency key, and replay an unchanged request with the same key after response loss.

Store only summary, facts, assumptions, impact, and recommendation within the published limits. Never store secrets, raw logs, stack traces, large diffs, provider responses, chain-of-thought, personal paths, or runtime binding material.

Every application operation requires the valid runtime binding issued by WithMate for the current provider execution. `session.self` returns only that binding's actor Session ID and does not accept a caller-supplied Session ID. All other Session-scoped operations keep an explicit target, including cross-Session handoff; the actor is never used as an implicit target.

`turn.run` and `turn.enqueue` use the following canonical Role and hierarchy matrix. The runtime derives the actor from its binding and reads both actor and target bindings; request fields cannot override the relationship.

| Actor Role | Allowed target |
| --- | --- |
| `standalone` | Self only |
| `overall-coordinator` | Self, a direct `task-coordinator` child, or a direct `executor` child |
| `task-coordinator` | Self, a direct `executor` child, the root `overall-coordinator`, or a sibling `task-coordinator` with the same root and parent |
| `executor` | Self or its direct parent (`overall-coordinator` or `task-coordinator`) |

Cross-root Turns, overall-coordinator-to-grandchild Turns, executor-to-sibling or other-branch Turns, nonexistent targets, and caller-supplied Role or hierarchy claims are rejected before execution or queue acceptance. Trusted GUI messages are a separate user-invocation boundary and are not restricted by this Agent matrix. `runtime.catalog.sessionTurnCommunicationContractRevision` identifies this Turn communication contract.

## Turn lifecycle

Resolve the provider and catalog revision through `runtime.catalog`, then create or select a Session and call `turn.options`. Codex Turns use Codex-specific sandbox options; Copilot Turns use Copilot-specific custom-agent options. Do not mix provider-specific fields or fall back to Session defaults.

`work.create`, `turn.run`, and `turn.enqueue` require the target Session's current `revision` as `expectedContainerRevision`. Every public execution includes its current `revision`; `turn.cancel` requires that value as `expectedRevision`. Refresh the target or execution after each mutation before issuing a changed request.

`turn.run` attempts immediate admission and returns `SESSION_BUSY` instead of queueing. `turn.enqueue` commits to the Session's persistent FIFO and returns immediately. Each Session may hold at most 10 waiting executions; active or running execution is not counted. Preserve `executionId` and observe one of `queued`, `running`, `completed`, `failed`, `canceled`, or `interrupted`.

Queued work not yet admitted can resume after restart. Work persisted as running becomes `interrupted` and is not automatically dispatched again. Replaying its original idempotency key returns the original execution; an intentional rerun requires a new key.

A wait timeout and MCP or CLI disconnect affect delivery only. They do not cancel the Turn. Use `turn.cancel` explicitly with the target Session, execution, authority, and its own idempotency key.

## Idempotency and reconciliation

Effect-bearing operations are Session create, configure, rename, move, clone, restore, archive, and delete, Session file write, Work Item create, revise, reassign, move, clone, reopen, archive, restore, delete, transition, result, cancel, aggregation decide, and aggregation retry, Turn run, enqueue, and cancel, interaction response, Coordination create, resolve, consume, cancel, and correct, and SessionFolder transcript export. Manifest reads are read-only. The fingerprint includes values that change the effect. Response mode, wait timeout, and request ID are delivery settings and do not change the fingerprint.

- Same operation, same key, same effect-bearing input: converge on the canonical result.
- Same operation and key, different effect-bearing input: `IDEMPOTENCY_CONFLICT` with no new effect.
- Different operation with the same key: separate scope, except Coordination mutations, whose keys share one principal Session scope and conflict across operations; never use key reuse to convert run and enqueue or one Coordination mutation into another.
- `CATALOG_REVISION_STALE`: refresh catalog or Turn options. If only the stale revision changes and the intended Turn tuple remains supported, resend according to the current schema's reconciliation contract; do not manufacture a second execution.
- `effect: not_applied`: no effect was started by that response.
- `effect: applied`: adopt the canonical public identifier in `details` or result.
- `effect: indeterminate`: inspect known identifiers and retry only the unchanged request with the same key.

Idempotency records are retained for 24 hours. Do not rely on a retained replay outside that window.

## Interaction

List pending interactions for an explicit Session and retain each item's `revision` and `decisionClass`. A response requires matching `sessionId`, `executionId`, and `interactionId`, plus the current `expectedRevision`. `user_only` requires a user-principal receipt issued by the trusted GUI, and `deny_or_cancel` cannot be answered by an Agent. Provider approval and elicitation are currently stored as `user_only`, so an Agent must wait for the GUI response rather than call `interaction.respond` or manufacture user authority. Reject delayed, already-resolved, or wrong-owner interactions.

An MCP application error uses `isError: true` and a versioned error envelope. A completed operation whose execution state is `failed` is still a normal structured result; inspect its terminal error fields.

## Pagination and limits

Cursor-based Session, Turn, and Interaction lists use a default limit of 50 and a maximum of 500. Work Item lists (`work.list` and `work.aggregation.list`) use a default limit of 50 and a maximum of 200. Never parse or synthesize a cursor. Send `nextCursor` back unchanged with the same operation, filter, and sort context.

Coordination event lists are the exception: default 50, maximum 100. Their cursors are also bound to the principal Session, scope, kind, and state.

- Request body, public response, and inline text hard limit: 8 MiB
- Turn attachments: at most 32
- Session file read/write: default 1 MiB, maximum 8 MiB
- Transcript inline: default 1 MiB, maximum 8 MiB
- SessionFolder transcript: default 64 MiB, maximum 1 GiB

Limits use UTF-8 byte counts. Oversized content fails instead of truncating. The Windows v6.4 runtime publishes only to an absent SessionFolder target. `replace: true` against an existing target fails before the target is changed because a safe identity-bound replacement primitive is not available. Transcript SessionFolder publication is atomic and uses a destination idempotency key.

## Stable error handling

Handle at least these public codes by code rather than message text:

- Identity and lookup: `SESSION_NOT_FOUND`, `EXECUTION_NOT_FOUND`, `INTERACTION_NOT_FOUND`
- Work Item: `WORK_ITEM_NOT_FOUND`, `WORK_ITEM_FORBIDDEN`, `WORK_ITEM_EXECUTION_FORBIDDEN`, `WORK_ITEM_PARENT_INVALID`, `WORK_ITEM_AGGREGATION_PARENT_INVALID`, `WORK_ITEM_STATE_CONFLICT`, `WORK_ITEM_REVISION_CONFLICT`
- State and capacity: `SESSION_BUSY`, `QUEUE_FULL`, `EXECUTION_STATE_CONFLICT`
- Retry and selection: `IDEMPOTENCY_CONFLICT`, `CATALOG_REVISION_STALE`, `RUNTIME_UNAVAILABLE`
- Validation and size: `INVALID_INPUT`, `LIMIT_EXCEEDED`, `CONTENT_TOO_LARGE`, `FILE_NOT_FOUND`

Do not bypass a normally responding structured application error through another transport. A retryable error still obeys its reported `effect` and idempotency rules.

## Adoption and handoff

When another Session changes source, inspect its diff and run the relevant executable contracts in the calling workspace before adopting it. For a handoff, explicitly choose the destination Session and enqueue a prompt that states:

- completed work and changed files;
- validation already run and its result;
- unresolved conflicts or risks;
- the next concrete objective.

The runtime transports the prompt and validates the destination. It does not generate the handoff meaning, infer the caller, or automatically forward terminal failures.
