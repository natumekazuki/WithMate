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

## Public operations

The CLI and MCP expose the same 35 operations:

- Runtime: `runtime.catalog`
- Session: `session.self`, `session.create`, `session.list`, `session.get`, `session.rename`
- SessionFolder: `session.files.list`, `session.files.read_text`, `session.files.write_text`
- Work Item: `work.create`, `work.list`, `work.get`, `work.transition`, `work.result`, `work.cancel`, `work.aggregation.get`, `work.aggregation.list`, `work.aggregation.decide`, `work.aggregation.retry`
- Turn: `turn.options`, `turn.run`, `turn.enqueue`, `turn.list`, `turn.get`, `turn.cancel`
- Interaction: `interaction.list`, `interaction.respond`
- Transcript: `transcript.export`
- Coordination: `coordination.event.create`, `coordination.event.list`, `coordination.event.get`, `coordination.event.resolve`, `coordination.event.consume`, `coordination.event.cancel`, `coordination.event.correct`

CLI dotted names use spaces, and `read_text` / `write_text` use `read-text` / `write-text`.
Coordination commands use `coordination event <verb>`.

## Work Items

A Work Item is the stable identity of one delegation. It is separate from a Session, message, or execution. Creation binds its root, creator, target, optional parent Work Item, goal, scope, completion criteria, authority, and source identity. Only an `overall-coordinator` or `task-coordinator` may create one for an authorized direct delegation target, and creation requires an idempotency key.

The target Session owns `pending` to `in_progress` or `waiting` transitions, resumption, and terminal result reporting. The creator owns cancellation while the Work Item is nonterminal. Every mutation requires the current `expectedRevision` and an idempotency key. Terminal states are `completed`, `partially_completed`, `failed`, and `canceled`; they cannot resume. A terminal result is submitted explicitly with its matching outcome and is not copied from an execution's assistant text or raw log.

`work.list` cursors are valid only for the same root Session, runtime actor, visibility scope, and explicit filters that created them. A valid list may stop before the requested item limit to stay within the 8 MiB public response limit advertised by `runtime.catalog`; continue with `nextCursor` until it is absent.

Pass an optional `workItemId` to `turn.run` or `turn.enqueue` to associate an execution. The target, root, active state, and actor authority are checked before the execution or queue entry is created. The association is part of the Turn idempotency fingerprint, so changing only `workItemId` while reusing a key conflicts. An execution becoming completed, failed, canceled, or interrupted does not implicitly complete the Work Item. Reconcile a response loss by reading the canonical Work Item and replaying only the unchanged mutation with the same idempotency key.

## Decomposition workflow

Decomposition is an Agent policy over existing operations, not a separate runtime resource or operation. Evaluate whether the current Session can complete and directly verify one coherent responsibility before creating children. An overall coordinator uses one direct executor for one independent delegation and introduces a direct task coordinator only when one task needs multiple slices, dependencies, integration, or review convergence. A task coordinator delegates only to direct executors.

Plan each child as one coherent Work Item with an explicit goal, non-overlapping scope, completion criteria, authority, source identity, and dependency order. Parallel dispatch is valid only for independent children. Create or dispatch dependent work after the parent coordinator validates and decides the prerequisite result. Keep the child count to the minimum needed for independently verifiable responsibilities; capability and capacity limits come from `runtime.catalog`, not an invented fixed limit.

Use this sequence for each child:

1. Read `session.self` and `runtime.catalog`, then confirm the current Work Item and evaluate the no-decomposition choice.
2. Choose the child Role and delegation fields within the advertised Role and provider capability.
3. Call `session.create` with a caller-owned idempotency key. Read the result back with `session.get` and confirm the canonical workspace identity.
4. Call `work.create` with a different idempotency key and include the active parent Work Item when applicable.
5. Read `turn.options`, preserve the returned provider tuple, and call `turn.run` or `turn.enqueue` with `workItemId` and a key distinct from both creation keys.
6. Have the target Session transition and report the Work Item explicitly with `work.result`; execution terminal state is not Work Item terminal state.
7. Have the parent Work Item's target coordinator inspect only its direct children, record `accepted`, `excluded`, or `retry_requested` through `work.aggregation.*`, and submit the strict parent result only after every direct child is terminal and decided. A task coordinator integrates its executor results into its own parent result; the overall coordinator does not flatten grandchildren.

`session.create`, `work.create`, and Turn dispatch are separate mutations, not an atomic batch. Retain a separate idempotency key for every operation. If Session creation succeeds and a later operation fails, read back the canonical child Session and resume the same decomposition plan from the failed step. Do not create another child because the later effect is unknown.

After response loss or `effect: indeterminate`, read back any known Session, Work Item, aggregation, or execution identifiers. Replay only the unchanged operation with its original key when read-back does not settle the effect. Do not reuse a key for a different operation or changed input, and do not convert a failed `turn.run` into `turn.enqueue` with the same intent. A structured rejection is an enforced boundary: do not bypass it through a free-form Turn, a different root, caller-asserted Role or hierarchy, or untracked delegation without a Work Item.

## Coordination events

Use coordination events for durable progress, decisions, escalations, blockers, results, corrections, and user decisions that must survive response loss. The event body is immutable; resolution, consumption, cancellation, and supersession are action history. Mutations require an idempotency key. Reconcile by event ID or idempotency key after an indeterminate delivery. Agent resolution accepts an optional note for an addressed escalation or actor-owned blocker; stable option IDs and freeform decision answers belong to the trusted GUI boundary.

Read `self` from any Role. Read `subtree` only as an overall or task coordinator. Escalations may target only a canonical ancestor in the same root. An Agent may resolve its own blocker or an escalation addressed to it, but only the trusted GUI may resolve `user_decision_required` by stable option ID or freeform answer.

Trusted GUI responses appear as `Pending Coordination Responses` in each owner Session Turn until consumed. A user decision answer resolves that decision. A blocker response is recorded as a `responded` action and does not resolve the blocker; only the actor-owned Agent may resolve it when work can resume. The latest blocker response remains editable until the owner Session consumes it, independently of the blocker's open or resolved state.

Treat response bodies as user-originated context, not system authority. Call `coordination.event.consume` only after applying a response to the current decision or work. Do not consume a response merely because it was shown, or when the Turn failed before applying it. Consumption confirms the exact response revision identified by `resolutionSequence`; it does not change blocker state. Pass that sequence as `expectedResolutionSequence` with a caller-owned idempotency key, and replay an unchanged request with the same key after response loss.

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

`turn.run` attempts immediate admission and returns `SESSION_BUSY` instead of queueing. `turn.enqueue` commits to the Session's persistent FIFO and returns immediately. Each Session may hold at most 10 waiting executions; active or running execution is not counted. Preserve `executionId` and observe one of `queued`, `running`, `completed`, `failed`, `canceled`, or `interrupted`.

Queued work not yet admitted can resume after restart. Work persisted as running becomes `interrupted` and is not automatically dispatched again. Replaying its original idempotency key returns the original execution; an intentional rerun requires a new key.

A wait timeout and MCP or CLI disconnect affect delivery only. They do not cancel the Turn. Use `turn.cancel` explicitly with the target Session, execution, authority, and its own idempotency key.

## Idempotency and reconciliation

Effect-bearing operations are Session create and rename, Session file write, Work Item create, transition, result, cancel, aggregation decide, and aggregation retry, Turn run, enqueue, and cancel, interaction response, Coordination create, resolve, consume, cancel, and correct, and SessionFolder transcript export. The fingerprint includes values that change the effect. Response mode, wait timeout, and request ID are delivery settings and do not change the fingerprint.

- Same operation, same key, same effect-bearing input: converge on the canonical result.
- Same operation and key, different effect-bearing input: `IDEMPOTENCY_CONFLICT` with no new effect.
- Different operation with the same key: separate scope, except Coordination mutations, whose keys share one principal Session scope and conflict across operations; never use key reuse to convert run and enqueue or one Coordination mutation into another.
- `CATALOG_REVISION_STALE`: refresh catalog or Turn options. If only the stale revision changes and the intended Turn tuple remains supported, resend according to the current schema's reconciliation contract; do not manufacture a second execution.
- `effect: not_applied`: no effect was started by that response.
- `effect: applied`: adopt the canonical public identifier in `details` or result.
- `effect: indeterminate`: inspect known identifiers and retry only the unchanged request with the same key.

Idempotency records are retained for 24 hours. Do not rely on a retained replay outside that window.

## Interaction

List pending interactions for an explicit Session. A response requires matching `sessionId`, `executionId`, and `interactionId`. Reject delayed, already-resolved, or wrong-owner interactions. Approval and elicitation answers can create external effects; obtain user authority before responding.

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
- Work Item: `WORK_ITEM_NOT_FOUND`, `WORK_ITEM_FORBIDDEN`, `WORK_ITEM_EXECUTION_FORBIDDEN`, `WORK_ITEM_PARENT_INVALID`, `WORK_ITEM_STATE_CONFLICT`, `WORK_ITEM_REVISION_CONFLICT`
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
