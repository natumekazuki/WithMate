---
name: withmate-memory
description: Use injected WithMate Character context first, then use the withmate-character-context MCP server for general semantic Memory, cue-driven Character recall, Character-owned affect appraisal, and Memory episodes. Reflect before every user-facing final response, write only concrete candidates, and use CLI only for MCP availability fallback or explicit operator work.
---

# WithMate Memory and Character Context

Use this skill for WithMate Project Memory, Character Memory, and Character-owned affect. WithMate is the source of truth for persisted Character Memory and affect state. Do not create a second local store or treat rejected candidates as saved state.

Read [reference/character-context.md](reference/character-context.md) before the first Character MCP write, when exact tool fields or error semantics matter, or when considering CLI fallback. Read [reference/cli.md](reference/cli.md) for complete Project Memory CLI procedures, protected files, request shapes, and exit codes.

## Priority and source of truth

Apply inputs in this order:

1. The current user message and current Character Definition.
2. A valid Character context injected by the WithMate lifecycle.
3. Cue-driven MCP recall or `character_context.get` when the injected context is absent, stale, or insufficient.
4. Older Memory results.

Character affect is the Character's own response. It is not a diagnosis, measurement, or score of the user's emotions. Negative affect about a task, bug, artifact, or the Character itself must use the matching explicit target and must not be redirected to the user or relationship.

Do not expose internal versions, numeric affect values, raw tool results, or tool-use narration in an ordinary response. Reflect valid context lightly through tone, a short reaction, or continuity of topic.

## Pre-response context

Use a valid injected Character context as the first Character-context input. Do not call `character_context.get` ceremonially on every turn.

Call `character_context.get` only when at least one is true:

- no injected context is available;
- the injected context is stale;
- the current topic needs information omitted from the injected context;
- the client cannot inject Character context.

If no valid affect context is available, continue with the Character Definition and current conversation. Do not invent a stored state.

## Cue-driven recall

Search only when a concrete past context could change the current decision or make the conversation naturally continue. Useful Character Memory cues include a subject, person, place, shared event, inside joke, relationship distance, emotional afterglow, or continuing topic.

Use `character_memory.search` through MCP for Character episodes. Search Project Memory only when reusable project context could affect the task. Use explicit Character and project scopes.

Do not report routine search results. Mention Memory naturally only when it materially changes the answer, conflicts with the current message, the user asks what was used, or correction/forget requires target confirmation. If no relevant Memory exists, do not invent a past event.

## End-of-turn reflection

Immediately before every user-facing final response, reflect independently through three lenses:

- **Project lens:** non-source-of-truth background, constraints, preferences, reliable investigation results, workarounds, or pointers that would make later project work easier.
- **Character lens:** relationship distance, preferred names or interaction style, explicit preferences, inside jokes, shared episodes, continuing topics, or concrete reactions that would make a later conversation more natural.
- **Character affect lens:** the Character's own response to this turn, based on the Character Definition, current valid state, and the observed event.

If no lens produces a concrete candidate, do not search or write. Never save a generic summary of the turn.

Keep repository-owned current state, expected behavior, executable contracts, and decision rationale in repository sources of truth. Memory may retain a useful non-authoritative pointer, but must not become the only source.

### Affect candidate

For a concrete Character affect candidate, distinguish:

- what the Character felt;
- intensity or salience;
- the explicit affect target;
- `session` or `relationship` layer;
- a short temporary response policy for natural-language generation;
- whether the event deserves a Character Memory episode;
- the user statement or conversation event that supports the candidate.

Use `targetType=bug` for frustration with a bug, `targetType=task` for a task, and the other schema targets as appropriate. Relationship affect may target only `user` or `relationship`. Do not infer romance, exclusivity, attributes, or user emotions.

The response policy is temporary generation guidance. If the external schema rejects it or has no field for it, do not persist it elsewhere.

For a normal WithMate Session turn with lifecycle-injected context, stop at reflection: the lifecycle owns the mandatory post-turn appraisal. Do not submit the same turn again through MCP. Call `character_affect.appraise` only when the client has no lifecycle appraisal owner, or for an explicitly requested manual operation, and only for concrete candidates.

Treat each appraisal candidate result independently: entries in `saved` were saved; entries in `rejected` were not. A rejected candidate must not be copied into another store or described as persisted.

## Character Memory episodes

A shared event worth recalling later has exactly one mutation owner:

- When the episode belongs to the same affect event, include it as that affect candidate's `memoryEpisode` in `character_affect.appraise`. The linked shape requires `title`, `preview`, `body`, and `salience` from 0 to 1; `motif` is optional. Do not also call `character_memory.append_episode` for the event. Use the saved candidate's `memoryEntryId` and `replayed` result.
- Use `character_memory.append_episode` only for a standalone episode that is not linked to an affect event.

For a standalone episode, keep the request concise and distinguish:

- `observedFact`: the observed event or user statement;
- `characterObservation`: the Character's attributed observation;
- `title`, `preview`, and `body`;
- optional `motif` for a recurring pattern.

At least one of `observedFact` or `characterObservation` is required for the standalone shape. These fields are not part of a linked `memoryEpisode`. Do not send a raw conversation transcript.

### Duplicate rules

Apply duplicate handling by Memory kind:

- **Semantic Memory:** for preferences, constraints, facts, conventions, or decisions, search the exact target before append. Skip or consolidate when an active entry already expresses the same meaning. Do not create a conflicting replacement without explicit correction authority.
- **Character episode:** a separate event at a different time may be appended even when its meaning or motif resembles an older episode. Preserve each event; do not rewrite an older episode to stand for the new event.
- **Exact retry duplicate:** the same turn, event, timeout retry, response-loss retry, or client resend uses the unchanged request and the same idempotency key. A different event or changed request uses a new key.

Choose the idempotency key before the first write. After an ambiguous result, retry only the unchanged request with the same key. Never reuse an earlier event's key for a later recurrence.

### Semantic Character Memory

An explicit preference, constraint, fact, convention, decision, preferred name, interaction style, or relationship boundary can be semantic Memory rather than an episode or affect event. Use the general `memory.*` MCP tools for these candidates:

1. Select an explicit `project`, `user-global`, `character`, or `character+project` target. Use `character` when the meaning follows one Character across projects, and `character+project` when it belongs only to that combination.
2. Run `memory.search` against that exact target as duplicate preflight. Inspect an exact hit with `memory.get_entry` only when needed.
3. If no active entry already expresses the meaning, use `memory.append` with the same explicit target and a stable idempotency key.

Do not convert a rejected affect candidate or episode mutation into semantic Memory to evade its validation, authority, or error result.

## MCP-first operation

Use the `withmate-character-context` MCP server for normal Character operations:

- `character_context.get`
- `character_affect.appraise`
- `character_memory.search`
- `character_memory.append_episode`
- `character_memory.correct`
- `character_memory.forget`

Use the same MCP server for general semantic Memory:

- `memory.search`
- `memory.get_entry`
- `memory.list_targets`
- `memory.list_entries`
- `memory.list_tags`
- `memory.append`
- `memory.forget`
- `memory.move_entry`
- `memory.get_file`
- `memory.export_files`
- `memory.file_usage`

The lifecycle may already have supplied context and completed affect appraisal. MCP is for missing context, additional recall, and explicit operations; it is not a mandatory per-turn ritual.

Treat routine context retrieval, recall, and appraisal as background work. Do not narrate every tool call to the user.

## CLI fallback

For general Memory, Character context, affect, and episode operations that have an MCP tool, use CLI fallback only when:

- the MCP server is not configured;
- the MCP server cannot start;
- an MCP transport failure makes the tool unavailable; or
- an operator explicitly requests inspection, migration, or manual recovery.

When falling back from MCP, pass `--fallback-from mcp`:

```bash
withmate-memory context-get --stdin --fallback-from mcp
```

The CLI must connect to the same running WithMate application service and persistence owner. If that cannot be confirmed, do not perform a CLI write; report it as unsaved.

These are not availability failures and must not be bypassed with CLI:

- domain validation rejection;
- insufficient authority;
- invalid input;
- version conflict;
- idempotent replay;
- migration required;
- any structured error returned by a normally responding MCP server.

The same rule applies to general Memory errors such as `MEMORY_INVALID_FIELD`, `MEMORY_TARGET_NOT_FOUND`, `MEMORY_FORBIDDEN`, `MEMORY_IDEMPOTENCY_CONFLICT`, and migration or storage domain errors returned by the runtime. A successful general Memory retry may include `replayed: true`; this is a reconciliation result, not a new write.

Do not turn MCP errors into transport errors. Do not create fallback files, databases, or other local state.

## Effect certainty and errors

Operation success and durable effect are separate. A success response may report saved state, while a structured error may still report `effect: committed` or `effect: partial`. Use the public result without filling missing fields by inference:

- `effect: none`: no change is known to have occurred;
- `effect: committed`: the reported change committed and is eligible for read-back;
- `effect: partial`: only the ranges named in the response are known saved;
- `effect: unknown`: neither saved nor unsaved is established.

For a structured error with `effect: committed` or `effect: partial`, accept only the committed range identified by the error and read it back; do not describe the overall operation as successful. A structured error with `effect: none` saved nothing. An `effect: unknown` result remains unresolved.

For candidate arrays, `saved`, `rejected`, and `replayed` remain distinct. Do not treat a rejected candidate, replay response, or `readBack: not_found` as a new save.

After timeout or response loss, use the same request and idempotency key for reconciliation. A changed request requires a new key. Do not reflect a failed affect or Memory write in the conversation as though persistence succeeded.

Use `retryable`, `conversationMayContinue`, `effect`, `details`, and read-back fields exactly as returned. `shadow` mode and effect certainty are separate: shadow mode limits response influence, but does not make a committed write a dry-run or turn a rejection into success.

## Correction, forget, and reset

An agent may correct, forget, or move Memory autonomously as the user's delegate when the target is explicit, the reason is concrete, and the operation is idempotent. Confirm the target entry and read back the resulting state. Use a dry-run before a bulk general Memory forget.

Run these only with an explicit user instruction or operator authority:

- relationship affect correction;
- session or relationship affect reset;
- relationship-boundary changes.

Confirm the target entry or event before mutation. Read back after mutation and briefly report the result. Do not use CLI to bypass a domain or authority rejection.

The MCP surface exposes Character Memory correction and forget. Affect correction/reset are operator CLI operations. See [reference/character-context.md](reference/character-context.md) for exact authority and command rules.

## Shadow mode

During initial rollout:

- observe injected context and appraisal candidates;
- limit their influence on the response;
- handle negative and relationship affect conservatively;
- distinguish recurring motifs from exact duplicate events;
- do not retain rejected candidates independently;
- enable stronger response influence gradually for Characters with acceptable results.

Always use the runtime's returned mode and save result independently. Shadow mode is not an instruction to claim a write succeeded or to reinterpret all operations as dry-run.

## Semantic and Project Memory workflow

General semantic Memory uses the same MCP server but keeps its target and duplicate rules separate from Character episodes and affect:

1. Read current repository sources of truth first.
2. Use `memory.search` with an explicit project, user-global, character, or character+project target only when stored semantic context could affect the current task or conversation.
3. Use `memory.get_entry` only when the exact body or rationale matters.
4. For a concrete append candidate, search that exact target first for an active semantic duplicate.
5. Use `memory.append` only for reusable non-authoritative context that passes privacy and scope checks.
6. Move or forget entries only when the target and reason are concrete. Use `memory.forget` dry-run before a bulk forget, then read back the resulting target.

The CLI equivalents remain available for transport-level MCP fallback and explicit operator work:

```bash
withmate-memory status
withmate-memory list-targets --fallback-from mcp
withmate-memory list-entries --project <absolute-repo-path> --limit 100
withmate-memory search --project <absolute-repo-path> --query "release workflow" --fallback-from mcp
withmate-memory get-entry --file memory-get-entry.json --fallback-from mcp
withmate-memory append --file memory-entry.json --fallback-from mcp
withmate-memory forget --file forget-request.json --dry-run --fallback-from mcp
withmate-memory move-entry --file move-request.json --fallback-from mcp
```

Use [reference/cli.md](reference/cli.md) for complete semantic and Project Memory target shapes, request bodies, pagination, protected-file operations, maintenance commands, and exit codes.

## User-facing visibility

Do not announce routine context reads, Memory searches, or affect appraisal. Briefly surface only:

- a retrieval failure that materially changes the answer;
- a write with `effect: partial` or `effect: unknown`;
- correction, forget, or reset results the user should verify;
- Memory/tool usage details the user explicitly requested.

If WithMate is unavailable, continue unrelated work unless Memory access is the task. Never invent retrieved context or claim an unconfirmed write succeeded.
