# WithMate Session operation reference

## Runtime and schema

WithMate owns the Session database, provider adapters, loopback runtime, discovery, credentials, and cleanup. Keep the desktop app running for all commands except `schema`.

```powershell
withmate-session status
withmate-session schema
withmate-session runtime catalog
```

These are CLI fallback commands. Use them only when the user explicitly permits CLI fallback. The MCP host owns `withmate-session mcp-server`; never run that long-lived stdio entry through a shell or command-execution tool. Register the connection from WithMate Settings, then start a new Codex Session or restart Codex if the tools are not visible.

The CLI request, result, and error schema versions are `withmate-session-request-v2`, `withmate-session-result-v2`, and `withmate-session-error-v2`. MCP server version is `1.0.0`. Exact fields come from the current CLI `schema` output and MCP `tools/list`, not this prose reference.

On Windows, the packaged launcher is `<install-root>\withmate-session.cmd`. WithMate Settings registers that package-owned absolute path for Codex MCP. The installer does not create or overwrite a shared WindowsApps alias for Session CLI. CLI fallback therefore requires the packaged launcher path to be invoked explicitly or placed on PATH by the user. The runtime credential directory is `%LOCALAPPDATA%\WithMate\session-runtime`; a custom `WITHMATE_SESSION_RUNTIME_DIR` is rejected on Windows. Failure to establish a private owner ACL disables the runtime.

## CLI input and output

Pass an operation input through exactly one of `--json`, `--file`, or `--stdin`. Prefer a file or stdin for shell-sensitive or multiline JSON. `runtime catalog` accepts no operation input. JSON is the automation format; `--format text` is for human inspection.

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

The CLI and MCP expose the same 17 operations:

- Runtime: `runtime.catalog`
- Session: `session.create`, `session.list`, `session.get`, `session.rename`
- SessionFolder: `session.files.list`, `session.files.read_text`, `session.files.write_text`
- Turn: `turn.options`, `turn.run`, `turn.enqueue`, `turn.list`, `turn.get`, `turn.cancel`
- Interaction: `interaction.list`, `interaction.respond`
- Transcript: `transcript.export`

CLI dotted names use spaces, and `read_text` / `write_text` use `read-text` / `write-text`.

## Turn lifecycle

Resolve the provider and catalog revision through `runtime.catalog`, then create or select a Session and call `turn.options`. Codex Turns use Codex-specific sandbox options; Copilot Turns use Copilot-specific custom-agent options. Do not mix provider-specific fields or fall back to Session defaults.

`turn.run` attempts immediate admission and returns `SESSION_BUSY` instead of queueing. `turn.enqueue` commits to the Session's persistent FIFO and returns immediately. Each Session may hold at most 10 waiting executions; active or running execution is not counted. Preserve `executionId` and observe one of `queued`, `running`, `completed`, `failed`, `canceled`, or `interrupted`.

Queued work not yet admitted can resume after restart. Work persisted as running becomes `interrupted` and is not automatically dispatched again. Replaying its original idempotency key returns the original execution; an intentional rerun requires a new key.

A wait timeout and MCP or CLI disconnect affect delivery only. They do not cancel the Turn. Use `turn.cancel` explicitly with the target Session, execution, authority, and its own idempotency key.

## Idempotency and reconciliation

Effect-bearing operations are Session create and rename, Session file write, Turn run, enqueue, and cancel, interaction response, and SessionFolder transcript export. The fingerprint includes values that change the effect. Response mode, wait timeout, and request ID are delivery settings and do not change the fingerprint.

- Same operation, same key, same effect-bearing input: converge on the canonical result.
- Same operation and key, different effect-bearing input: `IDEMPOTENCY_CONFLICT` with no new effect.
- Different operation with the same key: separate scope; never use this to convert run and enqueue.
- `CATALOG_REVISION_STALE`: refresh catalog or Turn options. If only the stale revision changes and the intended Turn tuple remains supported, resend according to the current schema's reconciliation contract; do not manufacture a second execution.
- `effect: not_applied`: no effect was started by that response.
- `effect: applied`: adopt the canonical public identifier in `details` or result.
- `effect: indeterminate`: inspect known identifiers and retry only the unchanged request with the same key.

Idempotency records are retained for 24 hours. Do not rely on a retained replay outside that window.

## Interaction

List pending interactions for an explicit Session. A response requires matching `sessionId`, `executionId`, and `interactionId`. Reject delayed, already-resolved, or wrong-owner interactions. Approval and elicitation answers can create external effects; obtain user authority before responding.

An MCP application error uses `isError: true` and a versioned error envelope. A completed operation whose execution state is `failed` is still a normal structured result; inspect its terminal error fields.

## Pagination and limits

List operations use opaque cursors, a default limit of 50, and a maximum of 500. Never parse or synthesize a cursor. Send `nextCursor` back unchanged with the same operation, filter, and sort context.

- Request body, public response, and inline text hard limit: 8 MiB
- Turn attachments: at most 32
- Session file read/write: default 1 MiB, maximum 8 MiB
- Transcript inline: default 1 MiB, maximum 8 MiB
- SessionFolder transcript: default 64 MiB, maximum 1 GiB

Limits use UTF-8 byte counts. Oversized content fails instead of truncating. The Windows v6.4 runtime publishes only to an absent SessionFolder target. `replace: true` against an existing target fails before the target is changed because a safe identity-bound replacement primitive is not available. Transcript SessionFolder publication is atomic and uses a destination idempotency key.

## Stable error handling

Handle at least these public codes by code rather than message text:

- Identity and lookup: `SESSION_NOT_FOUND`, `EXECUTION_NOT_FOUND`, `INTERACTION_NOT_FOUND`
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
