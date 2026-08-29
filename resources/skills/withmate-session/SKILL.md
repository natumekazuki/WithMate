---
name: withmate-session
description: Operate persistent WithMate Sessions through the versioned withmate-session CLI or MCP server. Use when Codex needs to create or inspect a separate WithMate Session, run or queue a Turn in an explicit Session, record a durable coordination event, answer an interaction, exchange a SessionFolder brief, export a transcript, or hand work to another persistent Session instead of using an in-task Codex subagent.
---

# WithMate Session orchestration

Use WithMate Session orchestration for work that needs a separate persistent Session, workspace, Character, history, or queue. Use Codex subagents for temporary delegation inside the current task. Do not treat one as an alias for the other.

Use WithMate Session MCP tools that the Codex host has already exposed. Never start `withmate-session mcp-server` through a shell or command-execution tool; it is a long-running stdio server entry for the MCP host, not a normal task command.

If the MCP tools are missing, ask the user to register the Session MCP connection from WithMate Settings and start a new Codex Session or restart Codex. When the user specifically requires MCP, stop until the MCP tools are available. Use the installed `withmate-session` CLI only when the user explicitly permits CLI fallback. Do not invoke a helper copied into this Skill or depend on a source checkout. Read [references/operations.md](references/operations.md) before constructing an operation manually or handling a retry.

## Establish the target and authority

- Use `session.self` to resolve the current provider actor Session from its runtime binding. Do not infer it from prompts, workspace paths, parent relationships, or user-provided IDs.
- Every Session application operation requires the valid runtime binding issued by WithMate for the current provider execution. Do not treat CLI or MCP transport credentials as actor authority, and do not retry a binding rejection through an unbound terminal.
- Require an explicit target `sessionId` for every other Session-scoped operation. `session.self` does not authorize an implicit target or replace explicit cross-Session selection.
- Before `turn.run` or `turn.enqueue`, use the canonical bindings returned by `session.self` and `session.get` to select an allowed target. A standalone actor may target only itself. An overall coordinator may target itself or a direct task coordinator or executor child. A task coordinator may target itself, a direct executor child, its root overall coordinator, or a sibling task coordinator with the same root and parent. An executor may target only itself or its direct parent.
- Do not send a Turn across roots, from an overall coordinator to a grandchild executor, or from an executor to a sibling or another branch. Do not send actor Role, root, parent, or depth in the request; WithMate derives them from runtime and canonical Role bindings and rejects unauthorized Turns before acceptance.
- Confirm the target Session's workspace identity with `session.get` before changing source or adopting results.
- When one delegation must remain identifiable across retries or multiple Turns, create a Work Item before dispatch. Only an overall or task coordinator may create one, and the target Session owns progress transitions and terminal result reporting while the creator owns cancellation.
- Derive permission for Session creation, Turn execution, approval, elicitation, cancellation, overwrite, and other external effects from the user's instruction. This Skill does not grant additional authority.
- Treat another Session's output as an adoption candidate. Validate its source changes and executable contracts in the calling task before accepting them.

## Decide whether and how to decompose

The Agent owns the work-decomposition policy. WithMate owns the enforced Role hierarchy, authority, Session and Work Item state, Turn admission, and aggregation contract.

- Do not decompose a single coherent responsibility that one Session can complete and verify directly.
- An `overall-coordinator` uses a direct `executor` child for one independent delegation. Create a direct `task-coordinator` only when one task needs multiple slices, dependency management, integration, or review convergence.
- A `task-coordinator` decomposes only to its direct `executor` children. A permitted maximum depth is an enforcement limit, not a policy target; do not build every allowed layer.
- Define each child Work Item as one coherent delegation with an explicit goal, scope, completion criteria, authority, and source identity. Keep sibling scopes non-overlapping and assign integration ownership instead of leaving it implicit.
- Create the canonical Session and active Work Item for every planned child before dispatching any child. Under a current parent Work Item, this keeps undispatched dependencies visible to parent finalization. At root, retain every top-level Work Item ID and do not finish until each planned result is terminal and adopted or explicitly replaced; never let an untracked planned delegation disappear from closure.
- Dispatch children in parallel only when they are independent. For a child under a current parent Work Item, dispatch a dependent child only after the prerequisite result is terminal, validated as satisfying the dependency, and decided `accepted`. A `retry_requested` decision requires waiting for the replacement result and its later `accepted` decision. An `excluded` decision blocks dependent dispatch until the coordinator explicitly revises the plan; cancel and decide the unused dependent Work Item as `excluded` if it is no longer required. For a root top-level delegation, where no parent aggregation exists, require the prerequisite's terminal result to be validated and adopted through `work.get`; create a new top-level Work Item or revise the plan when it is not adoptable.
- Use the minimum number of children needed for independently verifiable responsibilities. Do not invent a fixed decomposition or parallelism limit that is absent from `runtime.catalog`.
- Treat each child result as an adoption candidate. A task coordinator validates its direct children and closes them through existing aggregation decisions and its strict parent result. A root overall coordinator validates and adopts each top-level result through `work.get` without inventing a parent aggregation.

WithMate derives the actor, Role, permitted child Role, root, parent, depth, and provider capability from `session.self`, `runtime.catalog`, and canonical resources. Do not bypass a rejected structure with a free-form Turn, another root, caller-asserted hierarchy, or delegation without a Work Item. Revise the decomposition within the advertised contract or ask the user when the required choice changes the result.

## Execute a tracked decomposition

1. Call `session.self` and `runtime.catalog` to establish the actor, Role, permitted capabilities, and current limits.
2. Resolve the current Work Item from the exact ID in the incoming delegation prompt. Call `work.get`, confirm that its canonical target is the actor from `session.self`, and verify its goal, scope, completion criteria, authority, and source identity before mutation. If it is `pending`, call `work.transition` to `in_progress` with its current `expectedRevision` and an operation-specific idempotency key. A root `overall-coordinator` has no current Work Item; evaluate the no-decomposition choice directly.
3. For every necessary child, choose its Role, goal, scope, completion criteria, authority, source identity, and dependency order before creating resources.
4. Materialize every planned child before dispatch: call `session.create` with a caller-owned idempotency key, then use `session.get` to confirm the canonical child and workspace identity.
5. Call `work.create` for every planned child with an operation-specific idempotency key. A task coordinator includes its active current Work Item as `parentWorkItemId`; a root overall coordinator omits `parentWorkItemId` for top-level children. Do not dispatch until every planned child has a canonical Work Item.
6. For each dependency-ready child, call `turn.options`, construct a currently supported provider tuple, and dispatch with `turn.run` or `turn.enqueue` using the Work Item ID and a separate key. Put the exact Work Item ID in the delegation prompt and require the target to confirm it with `work.get` before `work.transition` or `work.result`; the execution association alone is not prompt context. Do not switch operations after an admission failure. Leave dependent Work Items undispatched until their prerequisite satisfies the decision rules above.
7. After response loss or `effect: indeterminate`, read back the canonical Session, Work Item, or execution and replay only the unchanged mutation with its original key. Session creation and Work Item creation are not an atomic batch: if a later operation fails, resume the same plan from the existing canonical child rather than creating a duplicate Session.
8. Require the target Session to submit an explicit terminal Work Item result, then close according to scope. A task coordinator with a current parent Work Item calls `work.aggregation.get` before each `work.aggregation.decide` or `work.aggregation.retry`, passes the current `aggregateRevision` as `expectedAggregateRevision`, and reads again after each mutation. After every planned direct child is terminal and decided, it gets the aggregation once more and passes that revision to its own strict parent `work.result`. A root overall coordinator instead calls `work.get` for each top-level child, validates and adopts its terminal result, and finishes without aggregation decisions or a parent `work.result`; never flatten a grandchild result into root handling.

## Follow the discovery workflow

1. Confirm that the Session MCP tools are exposed by the current host. If CLI fallback was explicitly permitted, run `withmate-session status` when runtime availability or identity is uncertain.
2. Call `runtime.catalog`; select only a returned provider, retain its `catalogRevision`, and require the supported `sessionTurnCommunicationContractRevision` before cross-Session Turn selection.
3. Create a Session only with an explicit title, provider, catalog revision, workspace selection, and caller-owned idempotency key.
4. Call `turn.options` for the target Session. Construct a provider-specific Turn tuple only from that result.
5. When the Turn performs a tracked delegation, create or select its active Work Item and pass `workItemId`. Choose `turn.run` for immediate admission or `turn.enqueue` for the persistent FIFO. Never convert one to the other after a busy or queue error.
6. Retain the returned `executionId`. Poll with `turn.get` or `turn.list` when a deferred execution must be followed.
7. If an unresolved interaction appears, list it and respond only when the user granted the required authority.

Do not infer provider support, model, reasoning effort, approval mode, sandbox, custom agent, or provider options from local configuration or prior Sessions.

## Preserve idempotency and effect certainty

- Generate and retain a separate idempotency key for every effect-bearing operation. Its scope is the operation name plus key.
- Retry an unchanged request with the same key. Use a new key for a changed effect-bearing input or an intentional new execution.
- Delivery-only changes such as response mode or wait timeout do not create a new effect.
- After `CATALOG_REVISION_STALE`, refresh catalog or Turn options and follow the reconciliation rules in the reference before resending.
- A wait timeout or client disconnect does not cancel an execution.
- After MCP response loss, reconnect to the same verified WithMate runtime and apply the same identifier and idempotency reconciliation used by the CLI. Do not switch runtime instances to guess the outcome.
- For `effect: indeterminate` or a response lost after dispatch, inspect the canonical resource when its identifier is known, then resend the unchanged mutation with the same key if reconciliation requires it.
- Do not reinterpret a structured application error as MCP or CLI unavailability. Branch on `error.code`, `retryable`, `effect`, and safe `details`, not message text.
- A terminal execution with `state: "failed"` is a successful operation result describing a failed Turn, not an MCP tool failure.
- Do not derive Work Item state or result from execution state. The target must submit a strict terminal result explicitly, and each Work Item mutation uses its current revision plus a caller-owned idempotency key.

## Handle files, transcripts, and handoffs

- Use SessionFolder-relative paths only. Never pass an absolute path, `..`, or a symlink or junction escape.
- Session file operations support UTF-8 text, not arbitrary binary transfer. Ask the target Session to create large or binary artifacts in its own workspace.
- Use canonical JSON transcript output for machine processing. Respect requested size limits and never assume truncation.
- For a handoff, name the destination Session explicitly and compose a natural-language prompt containing the result, changes, verification, remaining issues, and next objective. Do not infer a return destination or auto-handoff a failed execution.

## Record coordination events

- Use `coordination.event.*` only for durable, user-visible coordination facts and state. Keep normal conversational responses separate.
- Preserve the canonical Role hierarchy: read `self` from any Role and `subtree` only as an overall or task coordinator. Do not send actor, Role, root, parent, or depth in an operation input.
- Resolve an escalation only when addressed to the actor, resolve an actor-owned blocker only as that actor, and leave user decisions to the trusted GUI. Agent resolution may include an optional note and never sends a decision option ID.
- A trusted GUI response to a blocker does not resolve it. Apply and consume the latest response separately, then resolve the blocker as its actor only when work can resume.
- Reconcile a lost mutation response by event ID or idempotency key. Do not repeat a changed input with the old key.

## Use the live schema

Use MCP `tools/list` as the exact MCP input and output schema. When CLI fallback was explicitly permitted, use `withmate-session schema` for CLI capability and exit-code discovery. An older installed Skill must not guess fields introduced by a newer runtime.

For command forms, limits, pagination, recovery, and stable error handling, read [references/operations.md](references/operations.md).
