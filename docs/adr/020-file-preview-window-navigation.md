# ADR 020: File preview window navigation

- Status: Accepted

## Context

File Explorer already owns an in-session central preview, while chat file links previously delegated local paths directly to the operating system. A detached preview must not create a second renderer or path-authorization policy.

## Decision

- A normal File Explorer click opens the existing central preview.
- Ctrl-click (Cmd-click on macOS) in File Explorer opens a detached preview window without replacing the central preview. The same modifier on a tracked Changes row opens that file's live Git Diff in the detached host; an untracked row opens its file preview.
- `Open Preview` in a live Git Diff opens the same root-scoped resource in the current central or detached host.
- A chat local-file link opens a detached preview window.
- `SessionFilePreview` and `SessionDiffPreview` remain the canonical renderers. The detached window is only a host with window-specific navigation.
- Detached windows are identified and reused by their canonical resource identity: `(sessionId, rootId, normalized relativePath)` for root-scoped resources, or `(sessionId, exact canonical real file path)` for absolute-file resources. The canonical absolute path is not case-folded or separator-rewritten, so case-sensitive Windows directories and POSIX filenames containing a literal backslash do not collapse distinct files. Reopening restores and focuses the existing window. Different resources may have different windows.
- Reopening a resource with an explicit file-preview or live-Git-Diff view navigates the reused detached host to that view before focusing it. A live Git Diff view additionally preserves its Git scope.
- Link resolution runs in the main process. Relative chat links use the active session Workspace; relative links activated inside a preview use the current file's directory. Files within the current Workspace, parent Session Folder, or an explicitly registered Additional Directory retain a root-scoped resource. A user-activated link to another existing regular file becomes an absolute-file preview resource without adding a root or provider permission.
- External URLs and directories retain the existing explicit open behavior. Directories outside the registered roots, missing paths, special files, and unsupported URL schemes return a visible failure and are not opened automatically by the operating system.
- Automatic local resources embedded by Markdown, including images, remain root-scoped. The unrestricted absolute-file path applies only to explicit file navigation and the explicit `Open` / `Show in Explorer` actions for the current preview.
- A detached Preview renderer may inspect, read, open, reveal, request Git change/diff projections for, or use as a link base only the canonical resource bound to its own window token. Root change results exposed to a detached Preview are filtered to that current file. Directory listing remains available only to the owning Session renderer; the detached Preview receives only root metadata needed for root-scoped Markdown resources.
- The owning Session renderer may directly inspect, read, or open only root-scoped resources. An outside-root file enters through explicit link navigation, and only the main process may resolve that link into an absolute-file preview resource.
- The detached preview keeps explicit `Open` and `Show in Explorer` actions as the entry points for operating-system side effects.
- Closing the originating Session window does not close detached previews. Closing a detached preview removes its token and reuse registry entry. Reset closes all detached previews.

## Alternatives

- Make the detached window the only preview: rejected because normal Explorer navigation benefits from the current central preview.
- Build a separate simplified preview renderer: rejected because it would duplicate rendering, encoding, image, Markdown, and Git-diff behavior.
- Continue opening chat file links in the operating system: rejected because it bypasses the in-app preview contract and gives chat and Explorer incompatible file navigation.
- Require a confirmation or Additional Directory registration for every file outside the roots: rejected because previewing a user-activated local file is read-only and must not implicitly broaden provider access; repeated authorization adds friction without protecting a separate authority boundary.

## Consequences

The main process remains the canonical navigation boundary. Renderer callers submit a validated root-scoped or absolute-file resource, or a raw link target with the current preview resource as its base. Absolute-file preview access does not change Session roots, Additional Directories, or provider instructions. File handles, canonical paths, and file identity are confirmed before inspect, read, open, or reveal operations. Preview entry loading rechecks session and window liveness for every caller sharing the load before reporting success. The encoded Windows-path parsing fixed with ISSUE-240 remains shared through `resolveOpenPathTarget`.
