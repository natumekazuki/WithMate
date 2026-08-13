import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../src/character-state.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import { selectWeightedRandomLaunchCharacterId } from "../src/character/character-launch-selection.js";
import { buildNewSession, type Session, type SessionSummary } from "../src/session-state.js";
import type {
  SessionRuntimeCreateInput,
  SessionRuntimePublicSessionFolder,
  SessionRuntimePublicWorkspace,
  SessionRuntimeRenameInput,
  SessionRuntimeSessionDetail,
  SessionRuntimeSessionGetResult,
  SessionRuntimeSessionListInput,
  SessionRuntimeSessionListResult,
  SessionRuntimeSessionSummary,
} from "../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SessionRuntimeProjectionLimitError,
} from "../src/session-external-runtime-contract.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import type { SessionLaunchSelection } from "./session-launch-selection-service.js";
import {
  SessionCrudIdempotencyConflictError,
  type SessionStorageV6,
  type SessionSummaryPagePosition,
} from "./session-storage-v6.js";

const SESSION_CRUD_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_LIST_CURSOR_VERSION = 1;
const SESSION_LIST_SORT = "last_active_at_desc_id_desc";
const NEUTRAL_CHARACTER_ID = "withmate-neutral-character";
const NEUTRAL_CHARACTER_NAME = "WithMate";

type SessionListCursor = {
  version: typeof SESSION_LIST_CURSOR_VERSION;
  operation: "session.list";
  sort: typeof SESSION_LIST_SORT;
  lastActiveAt: string;
  sessionId: string;
};

export class SessionCrudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = "SessionCrudError";
  }
}

export type SessionCrudServiceDeps = {
  storage: Pick<
    SessionStorageV6,
    | "resolveSessionCrudIdempotency"
    | "insertSessionIdempotently"
    | "renameSessionIdempotently"
    | "listSessionSummaryPage"
    | "getSessionSummary"
  >;
  resolveLaunchSelection(providerId: string): Promise<SessionLaunchSelection>;
  isProviderSupported(providerId: string): boolean;
  listCharacters(): CharacterCatalogEntry[];
  listSessionSummaries(): SessionSummary[];
  listOpenSessionWindowIds(): string[];
  createCharacterRuntimeSnapshot(characterId: string): CharacterRuntimeSnapshot | null;
  createSessionId(): string;
  createSessionFilesDirectory(sessionId: string): Promise<string>;
  resolveSessionFilesDirectory(sessionId: string): string;
  publishCreatedSession(session: Session): void;
  publishRenamedSession(session: SessionSummary): void;
  reportPublicationError?(operation: "session.create" | "session.rename", error: unknown): void;
  resolveCurrentWorkspaceBranch?(workspacePath: string): Promise<string | null>;
  now?(): Date;
  random?(): number;
};

export class SessionCrudService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionCrudServiceDeps) {}

  create(input: SessionRuntimeCreateInput): Promise<SessionRuntimeSessionDetail> {
    return this.enqueueMutation(() => this.createNow(input));
  }

  async list(input: SessionRuntimeSessionListInput): Promise<SessionRuntimeSessionListResult> {
    const position = input.cursor ? decodeSessionListCursor(input.cursor) : undefined;
    const page = this.deps.storage.listSessionSummaryPage(input.limit + 1, position);
    const visible = page.slice(0, input.limit);
    const last = visible.at(-1);
    return assertCrudProjectionSize({
      items: visible.map((entry) => projectSessionSummary(
        entry.summary,
        this.deps.resolveSessionFilesDirectory(entry.summary.id),
      )),
      ...(page.length > input.limit && last
        ? { nextCursor: encodeSessionListCursor({ lastActiveAt: last.lastActiveAt, sessionId: last.summary.id }) }
        : {}),
    });
  }

  async get(sessionId: string): Promise<SessionRuntimeSessionGetResult> {
    const session = this.requireDefaultSession(sessionId);
    const detail = projectSessionDetail(session, this.deps.resolveSessionFilesDirectory(session.id));
    const branch = detail.workspace.kind === "directory"
      ? await resolveCurrentWorkspaceBranch(this.deps.resolveCurrentWorkspaceBranch, detail.workspace.path)
      : null;
    return assertCrudProjectionSize(
      { ...detail, workspace: { ...detail.workspace, branch } },
    );
  }

  rename(input: SessionRuntimeRenameInput): Promise<SessionRuntimeSessionDetail> {
    return this.enqueueMutation(() => this.renameNow(input));
  }

  private async createNow(input: SessionRuntimeCreateInput): Promise<SessionRuntimeSessionDetail> {
    const fingerprint = fingerprintMutation({
      title: input.title,
      provider: input.provider,
      catalogRevision: input.catalogRevision,
      workspace: input.workspace,
    });
    const now = this.now();
    try {
      const replay = this.deps.storage.resolveSessionCrudIdempotency(
        "session.create",
        input.idempotencyKey,
        fingerprint,
        now.toISOString(),
      );
      if (replay.kind === "replay") {
        const result = normalizeSessionDetailProjection(replay.result as SessionRuntimeSessionDetail);
        return assertCrudProjectionSize(result, { sessionId: result.sessionId });
      }
    } catch (error) {
      throw mapStorageMutationError(error);
    }

    if (this.deps.isProviderSupported && !this.deps.isProviderSupported(input.provider)) {
      throw new SessionCrudError(
        "RUNTIME_UNAVAILABLE",
        "The requested provider is not supported by the external Session runtime.",
        false,
        { provider: input.provider },
      );
    }
    const launchSelection = await this.deps.resolveLaunchSelection(input.provider);
    if (launchSelection.provider !== input.provider) {
      throw new SessionCrudError(
        "RUNTIME_UNAVAILABLE",
        "The requested provider is not enabled.",
        true,
        { provider: input.provider },
      );
    }
    if (launchSelection.catalogRevision !== input.catalogRevision) {
      throw new SessionCrudError(
        "CATALOG_REVISION_STALE",
        "The requested catalog revision is no longer current.",
        true,
        { requestedRevision: input.catalogRevision, currentRevision: launchSelection.catalogRevision },
      );
    }

    const character = this.resolveRandomCharacter();
    const sessionId = this.deps.createSessionId().trim();
    if (!sessionId) {
      throw new SessionCrudError("RUNTIME_UNAVAILABLE", "Session ID generation failed.", true);
    }
    const workspace = await this.resolveCreateWorkspace(sessionId, input.workspace);
    const session = buildNewSession({
      id: sessionId,
      provider: launchSelection.provider,
      catalogRevision: launchSelection.catalogRevision,
      taskTitle: input.title,
      workspaceLabel: workspace.label,
      workspacePath: workspace.path,
      branch: workspace.branch,
      sessionKind: "default",
      characterId: character.id,
      character: character.name,
      characterIconPath: character.iconFilePath,
      characterThemeColors: character.theme,
      characterRuntimeSnapshot: character.runtimeSnapshot,
      approvalMode: launchSelection.approvalMode,
      codexSandboxMode: launchSelection.codexSandboxMode,
      model: launchSelection.model,
      reasoningEffort: launchSelection.reasoningEffort,
      customAgentName: launchSelection.customAgentName,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(workspace.path, []),
    });
    const createdAt = this.now();
    try {
      const stored = this.deps.storage.insertSessionIdempotently(session, {
        operation: "session.create",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + SESSION_CRUD_IDEMPOTENCY_TTL_MS).toISOString(),
        projectResult: (storedSession) => projectSessionDetail(
          storedSession,
          this.deps.resolveSessionFilesDirectory(storedSession.id),
        ),
      });
      if (!stored.replayed) {
        this.publishCommittedMutation("session.create", () => this.deps.publishCreatedSession(stored.session));
      }
      return assertCrudProjectionSize(
        normalizeSessionDetailProjection(stored.result as SessionRuntimeSessionDetail),
        { sessionId: stored.session.id },
      );
    } catch (error) {
      throw mapStorageMutationError(error);
    }
  }

  private async renameNow(input: SessionRuntimeRenameInput): Promise<SessionRuntimeSessionDetail> {
    const fingerprint = fingerprintMutation({ sessionId: input.sessionId, title: input.title });
    const now = this.now();
    try {
      const replay = this.deps.storage.resolveSessionCrudIdempotency(
        "session.rename",
        input.idempotencyKey,
        fingerprint,
        now.toISOString(),
      );
      if (replay.kind === "replay") {
        const result = normalizeSessionDetailProjection(replay.result as SessionRuntimeSessionDetail);
        return assertCrudProjectionSize(result, { sessionId: result.sessionId });
      }
      this.requireDefaultSession(input.sessionId);
      const renamed = this.deps.storage.renameSessionIdempotently({
        operation: "session.rename",
        sessionId: input.sessionId,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_CRUD_IDEMPOTENCY_TTL_MS).toISOString(),
        projectResult: (stored) => projectSessionDetail(
          stored,
          this.deps.resolveSessionFilesDirectory(stored.id),
        ),
      });
      if (!renamed) {
        throw new SessionCrudError("SESSION_NOT_FOUND", "The requested Session was not found.", false, {
          sessionId: input.sessionId,
        });
      }
      if (!renamed.replayed) {
        this.publishCommittedMutation("session.rename", () => this.deps.publishRenamedSession(renamed.session));
      }
      return assertCrudProjectionSize(
        normalizeSessionDetailProjection(renamed.result as SessionRuntimeSessionDetail),
        { sessionId: renamed.session.id },
      );
    } catch (error) {
      if (error instanceof SessionCrudError) throw error;
      throw mapStorageMutationError(error);
    }
  }

  private requireDefaultSession(sessionId: string): SessionSummary {
    const session = this.deps.storage.getSessionSummary(sessionId);
    if (!session) {
      throw new SessionCrudError("SESSION_NOT_FOUND", "The requested Session was not found.", false, { sessionId });
    }
    if (session.sessionKind !== "default") {
      throw new SessionCrudError("SESSION_KIND_UNSUPPORTED", "Only normal Sessions are supported.", false, {
        sessionId,
        sessionKind: session.sessionKind,
      });
    }
    return session;
  }

  private resolveRandomCharacter(): {
    id: string;
    name: string;
    iconFilePath: string;
    theme: { main: string; sub: string };
    runtimeSnapshot: CharacterRuntimeSnapshot | null;
  } {
    const summaries = this.deps.listSessionSummaries();
    const summariesById = new Map(summaries.map((session) => [session.id, session] as const));
    const openCharacterIds = this.deps.listOpenSessionWindowIds()
      .map((sessionId) => summariesById.get(sessionId)?.characterId ?? "")
      .filter(Boolean);
    const entries = this.deps.listCharacters();
    const characterId = selectWeightedRandomLaunchCharacterId(entries, summaries, openCharacterIds, () => this.random());
    const entry = entries.find((candidate) => candidate.state === "active" && candidate.id === characterId) ?? null;
    if (!entry) {
      return {
        id: NEUTRAL_CHARACTER_ID,
        name: NEUTRAL_CHARACTER_NAME,
        iconFilePath: "",
        theme: { ...DEFAULT_CHARACTER_THEME_COLORS },
        runtimeSnapshot: null,
      };
    }
    const runtimeSnapshot = this.deps.createCharacterRuntimeSnapshot(entry.id);
    if (!runtimeSnapshot) {
      throw new SessionCrudError("RUNTIME_UNAVAILABLE", "The selected Character could not be loaded.", true);
    }
    return {
      id: entry.id,
      name: entry.name,
      iconFilePath: entry.iconFilePath,
      theme: { ...entry.theme },
      runtimeSnapshot,
    };
  }

  private async resolveCreateWorkspace(
    sessionId: string,
    workspace: SessionRuntimeCreateInput["workspace"],
  ): Promise<{ kind: "directory" | "session_folder"; label: string; path: string; branch: string }> {
    if (workspace.kind === "session_folder") {
      let workspacePath: string;
      try {
        workspacePath = await this.deps.createSessionFilesDirectory(sessionId);
      } catch {
        throw new SessionCrudError(
          "RUNTIME_UNAVAILABLE",
          "The SessionFolder workspace could not be created.",
          true,
        );
      }
      return { kind: "session_folder", label: "SessionFolder", path: workspacePath, branch: "" };
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(workspace.path);
      if (!(await stat(canonicalPath)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new SessionCrudError("INVALID_INPUT", "workspace.path must reference an existing directory.", false, {
        field: "workspace.path",
      });
    }
    return {
      kind: "directory",
      label: path.basename(canonicalPath) || canonicalPath,
      path: canonicalPath,
      branch: "",
    };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation);
    this.mutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private publishCommittedMutation(
    operation: "session.create" | "session.rename",
    publish: () => void,
  ): void {
    try {
      publish();
    } catch (error) {
      this.deps.reportPublicationError?.(operation, error);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private random(): number {
    return this.deps.random?.() ?? Math.random();
  }
}

function projectSessionSummary(
  session: SessionSummary,
  sessionFolderPath: string,
): SessionRuntimeSessionSummary {
  const workspaceKind = samePath(session.workspacePath, sessionFolderPath) ? "session_folder" : "directory";
  return {
    sessionId: session.id,
    title: session.taskTitle,
    sessionKind: "default",
    provider: { id: session.provider, catalogRevision: session.catalogRevision },
    character: { id: session.characterId, name: session.character },
    workspace: {
      kind: workspaceKind,
      label: session.workspaceLabel,
      path: session.workspacePath,
    },
    updatedAt: session.updatedAt,
  };
}

function projectSessionDetail(
  session: Session | SessionSummary,
  sessionFolderPath: string,
): SessionRuntimeSessionDetail {
  const summary = projectSessionSummary(session, sessionFolderPath);
  const isWorkspace = samePath(session.workspacePath, sessionFolderPath);
  const workspace: SessionRuntimePublicWorkspace = {
    ...summary.workspace,
    kind: isWorkspace ? "session_folder" : "directory",
  };
  const sessionFolder: SessionRuntimePublicSessionFolder = { path: sessionFolderPath, isWorkspace };
  return { ...summary, workspace, sessionFolder };
}

function normalizeSessionDetailProjection(
  detail: SessionRuntimeSessionDetail,
): SessionRuntimeSessionDetail {
  return {
    sessionId: detail.sessionId,
    title: detail.title,
    sessionKind: "default",
    provider: {
      id: detail.provider.id,
      catalogRevision: detail.provider.catalogRevision,
    },
    character: {
      id: detail.character.id,
      name: detail.character.name,
    },
    workspace: {
      kind: detail.workspace.kind,
      label: detail.workspace.label,
      path: detail.workspace.path,
    },
    updatedAt: detail.updatedAt,
    sessionFolder: {
      path: detail.sessionFolder.path,
      isWorkspace: detail.sessionFolder.isWorkspace,
    },
  };
}

async function resolveCurrentWorkspaceBranch(
  resolver: SessionCrudServiceDeps["resolveCurrentWorkspaceBranch"],
  workspacePath: string,
): Promise<string | null> {
  if (!resolver) return null;
  try {
    const branch = await resolver(workspacePath);
    return typeof branch === "string" && branch.trim() ? branch.trim() : null;
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function fingerprintMutation(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapIdempotencyError(error: unknown): Error {
  if (error instanceof SessionCrudIdempotencyConflictError) {
    return new SessionCrudError("IDEMPOTENCY_CONFLICT", error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function mapStorageMutationError(error: unknown): Error {
  if (error instanceof SessionRuntimeProjectionLimitError) {
    return error;
  }
  const mapped = mapIdempotencyError(error);
  if (mapped !== error || mapped instanceof SessionCrudError) {
    return mapped;
  }
  return new SessionCrudError(
    "RUNTIME_UNAVAILABLE",
    "The Session mutation could not be persisted.",
    true,
  );
}

function assertCrudProjectionSize<T>(
  result: T,
  details: Record<string, string | number | boolean> = {},
): T {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
    throw new SessionRuntimeProjectionLimitError("result", details);
  }
  return result;
}

function encodeSessionListCursor(position: SessionSummaryPagePosition): string {
  const cursor: SessionListCursor = {
    version: SESSION_LIST_CURSOR_VERSION,
    operation: "session.list",
    sort: SESSION_LIST_SORT,
    lastActiveAt: position.lastActiveAt,
    sessionId: position.sessionId,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSessionListCursor(value: string): SessionSummaryPagePosition {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SessionListCursor>;
    if (
      parsed.version !== SESSION_LIST_CURSOR_VERSION ||
      parsed.operation !== "session.list" ||
      parsed.sort !== SESSION_LIST_SORT ||
      typeof parsed.lastActiveAt !== "string" ||
      !parsed.lastActiveAt ||
      typeof parsed.sessionId !== "string" ||
      !parsed.sessionId
    ) {
      throw new Error("invalid cursor");
    }
    return { lastActiveAt: parsed.lastActiveAt, sessionId: parsed.sessionId };
  } catch {
    throw new SessionCrudError("INVALID_CURSOR", "The Session list cursor is invalid.", false, { field: "cursor" });
  }
}
