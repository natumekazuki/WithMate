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
- Confirm the target Session's workspace identity with `session.get` before changing source or adopting results.
- Derive permission for Session creation, Turn execution, approval, elicitation, cancellation, overwrite, and other external effects from the user's instruction. This Skill does not grant additional authority.
- Treat another Session's output as an adoption candidate. Validate its source changes and executable contracts in the calling task before accepting them.

## Follow the discovery workflow

1. Confirm that the Session MCP tools are exposed by the current host. If CLI fallback was explicitly permitted, run `withmate-session status` when runtime availability or identity is uncertain.
2. Call `runtime.catalog`; select only a returned provider and retain its `catalogRevision`.
3. Create a Session only with an explicit title, provider, catalog revision, workspace selection, and caller-owned idempotency key.
4. Call `turn.options` for the target Session. Construct a provider-specific Turn tuple only from that result.
5. Choose `turn.run` for immediate admission or `turn.enqueue` for the persistent FIFO. Never convert one to the other after a busy or queue error.
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
