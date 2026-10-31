---
name: withmate-glossary
description: Use withmate-glossary MCP or CLI to list, search, read, validate, and safely create repository glossary entries, or update and delete entries after an explicit user request. Use when repository-specific terms, aliases, boundary names, or concepts need explanation or durable registration in .withmate/glossary.yaml.
---

# WithMate Glossary

Treat the selected Git checkout's `.withmate/glossary.yaml` as the only source of truth. MCP and CLI use the same operation schemas, runtime authorization, and application service. Do not copy glossary contents into Memory, Session data, prompts, this Skill, or another cache.

## Target and reads

1. With a Session binding, use `{ "kind": "primary" }` or call `glossary.list_targets` for the authorized opaque `checkoutId`. An explicit repository selector remains restricted to that authorized checkout; invalid bindings never fall back to unbound access.
2. Without a Session binding, explicitly supply `{ "kind": "repository", "path": "<absolute-path>" }` to every operation, including `list_targets`. Do not infer the repository from the working directory or a repository name.
3. Use `glossary.list`, `glossary.search`, `glossary.get`, or `glossary.validate` for reads. A missing file is a valid read state and must not create `.withmate/` or `glossary.yaml`.

Definitions are plain text. Do not render or reinterpret Markdown or HTML found in a definition.

## Create

Use `mode: "explicit"` when the user asks to add an entry.

Without a Session binding, create and create_batch support only explicit mode. Do not replace a proactive request with explicit mode.

Use `mode: "proactive"` only when every condition below holds:

- the term is a repository-specific term, alias, boundary name, or concept;
- its meaning is grounded in source, an accepted document, an executable contract, or a user-confirmed explanation;
- it is reusable beyond the current task;
- it does not duplicate an existing entry or belong as an update;
- it contains no secret, personal information, personal machine path, or unpublished external information.

Do not proactively register general vocabulary, branch names, commit hashes, temporary file names, or speculation. Make at most one proactive `glossary.create` or `glossary.create_batch` call per turn. The runtime enforces the current Settings limit; do not guess, cache, or substitute a fallback limit.

## Update and delete

Run `glossary.update` or `glossary.delete` only after an explicit user request.

1. Read the current entry and revision.
2. Send that exact `expectedRevision` and `explicitUserRequest: true`.
3. Read back the result before reporting completion.

Do not retry a revision conflict with a newer revision unless the user-requested change is re-evaluated against the new current value.

## Result and retry safety

- `outcome: "applied"` means this attempt applied the requested postcondition and read it back.
- `outcome: "converged"` means the current value already matches the complete requested postcondition; it does not prove which attempt wrote it.
- `effect: "none"` means no change is known to have occurred.
- `effect: "unknown"` means the mutation result cannot be classified safely. Do not mutate again automatically. Read the current value and ask the user before choosing another write.

After response loss, retry only the unchanged request. Never turn a partial batch match into an implicit add of only the missing entries.

## CLI

Use `withmate-glossary <operation> --json '<request>'`, `--file <path>`, `@file`, or `--stdin`. `schema` returns the complete public input schemas. `--repository <absolute-path>` supplies the repository selector when it is not already in JSON. MCP and CLI require the running authenticated WithMate runtime; neither directly bypasses the application service.

Changing transport does not resolve a structured validation, authority, revision, conflict, or effect-certainty error. Do not pass a Session ID or use an explicit repository to escape an existing Session binding's scope.
