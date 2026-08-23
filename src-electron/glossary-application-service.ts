import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseDocument, stringify } from "yaml";

import {
  GLOSSARY_LIMITS,
  GLOSSARY_RELATIVE_PATH,
  GLOSSARY_SCHEMA_VERSION,
  type GlossaryCreateBatchRequest,
  type GlossaryCreateRequest,
  type GlossaryDeleteRequest,
  type GlossaryEntry,
  type GlossaryEntryInput,
  type GlossaryGetResult,
  type GlossaryListResult,
  type GlossaryMutationResult,
  type GlossaryOperationError,
  type GlossaryOperationErrorCode,
  type GlossaryOperationResult,
  type GlossaryPageRequest,
  type GlossarySearchRequest,
  type GlossarySnapshot,
  type GlossaryUpdateRequest,
  type GlossaryValidationIssue,
  type GlossaryValidationResult,
} from "../src/glossary-contract.js";

const execFileAsync = promisify(execFile);
const LOOKUP_WHITESPACE_PATTERN = /\p{White_Space}+/gu;
const NORMALIZED_REVISION_PATTERN = /^[a-f0-9]{64}$/;

export type GlossaryFileIdentity = {
  device: bigint;
  inode: bigint;
};

export type ResolvedGlossaryCheckout = {
  rootPath: string;
  rootRealPath: string;
  rootIdentity: GlossaryFileIdentity;
  gitMarkerIdentity: GlossaryFileIdentity;
};

export type GlossaryCheckoutAuthoritySnapshot = {
  rootPath: string;
  rootRealPath: string;
  rootDevice: string;
  rootInode: string;
  gitMarkerDevice: string;
  gitMarkerInode: string;
};

export type GlossaryMutationGuard = () => Promise<ResolvedGlossaryCheckout | null>;

export type GlossaryCheckoutDisplay = {
  repositoryName: string;
  branch: string;
  pathLabel: string;
};

type ValidRead = Extract<GlossarySnapshot, { status: "valid" }> & {
  raw: string;
  fileIdentity: GlossaryFileIdentity;
};

type MissingRead = Extract<GlossarySnapshot, { status: "missing" }>;
type InvalidRead = Exclude<GlossarySnapshot, { status: "valid" } | { status: "missing" }> & {
  raw: string;
  fileIdentity: GlossaryFileIdentity;
};
type InternalRead = MissingRead | ValidRead | InvalidRead;

type DirectoryIdentity = {
  path: string;
  realPath: string;
  identity: GlossaryFileIdentity;
};

type MutationPlan = {
  entries: GlossaryEntry[];
  previous: InternalRead;
  isConverged: (snapshot: GlossarySnapshot) => boolean;
};

export type GlossaryApplicationServiceDeps = {
  runGit?: (cwd: string, args: readonly string[]) => Promise<string>;
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void>;
  renamePath?: (oldPath: string, newPath: string) => Promise<void>;
};

class GlossaryServiceFailure extends Error {
  readonly error: GlossaryOperationError;

  constructor(error: GlossaryOperationError) {
    super(error.message);
    this.name = "GlossaryServiceFailure";
    this.error = error;
  }
}

function operationError(
  code: GlossaryOperationErrorCode,
  message: string,
  effect: GlossaryOperationError["effect"] = "none",
  retryable = false,
  issues?: GlossaryValidationIssue[],
): GlossaryOperationError {
  return {
    ok: false,
    code,
    message,
    effect,
    retryable,
    ...(issues ? { issues } : {}),
  };
}

function fail(
  code: GlossaryOperationErrorCode,
  message: string,
  effect: GlossaryOperationError["effect"] = "none",
  retryable = false,
  issues?: GlossaryValidationIssue[],
): never {
  throw new GlossaryServiceFailure(operationError(code, message, effect, retryable, issues));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isMissingError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function identityFromStats(stats: Stats): GlossaryFileIdentity {
  return {
    device: BigInt(stats.dev),
    inode: BigInt(stats.ino),
  };
}

function sameIdentity(left: GlossaryFileIdentity, right: GlossaryFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function areResolvedGlossaryCheckoutsEqual(
  left: ResolvedGlossaryCheckout,
  right: ResolvedGlossaryCheckout,
): boolean {
  return path.resolve(left.rootPath) === path.resolve(right.rootPath)
    && left.rootRealPath === right.rootRealPath
    && sameIdentity(left.rootIdentity, right.rootIdentity)
    && sameIdentity(left.gitMarkerIdentity, right.gitMarkerIdentity);
}

export function projectGlossaryCheckoutAuthority(
  target: ResolvedGlossaryCheckout,
): GlossaryCheckoutAuthoritySnapshot {
  return {
    rootPath: target.rootPath,
    rootRealPath: target.rootRealPath,
    rootDevice: target.rootIdentity.device.toString(),
    rootInode: target.rootIdentity.inode.toString(),
    gitMarkerDevice: target.gitMarkerIdentity.device.toString(),
    gitMarkerInode: target.gitMarkerIdentity.inode.toString(),
  };
}

export function restoreGlossaryCheckoutAuthority(
  snapshot: GlossaryCheckoutAuthoritySnapshot,
): ResolvedGlossaryCheckout {
  return {
    rootPath: snapshot.rootPath,
    rootRealPath: snapshot.rootRealPath,
    rootIdentity: {
      device: BigInt(snapshot.rootDevice),
      inode: BigInt(snapshot.rootInode),
    },
    gitMarkerIdentity: {
      device: BigInt(snapshot.gitMarkerDevice),
      inode: BigInt(snapshot.gitMarkerInode),
    },
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function normalizeGlossaryLookup(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(LOOKUP_WHITESPACE_PATTERN, " ")
    .trim();
}

function rawRevision(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

async function hashFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function exactEntryEqual(left: GlossaryEntry, right: GlossaryEntry): boolean {
  return left.term === right.term
    && left.definition === right.definition
    && left.aliases.length === right.aliases.length
    && left.aliases.every((alias, index) => alias === right.aliases[index]);
}

function cloneEntry(entry: GlossaryEntry): GlossaryEntry {
  return {
    term: entry.term,
    aliases: [...entry.aliases],
    definition: entry.definition,
  };
}

function validateEntry(input: GlossaryEntryInput, entryIndex: number): {
  entry: GlossaryEntry;
  issues: GlossaryValidationIssue[];
} {
  const issues: GlossaryValidationIssue[] = [];
  const pathPrefix = `entries[${entryIndex}]`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      entry: { term: "", aliases: [], definition: "" },
      issues: [{ path: pathPrefix, code: "INVALID_ENTRY", message: "Entry must be an object." }],
    };
  }

  const term = typeof input.term === "string" ? input.term : "";
  const definition = typeof input.definition === "string" ? input.definition : "";
  const aliases = input.aliases === undefined
    ? []
    : Array.isArray(input.aliases) && input.aliases.every((alias) => typeof alias === "string")
      ? [...input.aliases]
      : [];

  if (typeof input.term !== "string") {
    issues.push({ path: `${pathPrefix}.term`, code: "INVALID_TYPE", message: "term must be a string." });
  } else if (!term.trim()) {
    issues.push({ path: `${pathPrefix}.term`, code: "EMPTY_VALUE", message: "term must not be empty." });
  } else if (codePointLength(term) > GLOSSARY_LIMITS.maxTermCodePoints) {
    issues.push({ path: `${pathPrefix}.term`, code: "LIMIT_EXCEEDED", message: "term is too long." });
  }

  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || !input.aliases.every((alias) => typeof alias === "string"))) {
    issues.push({ path: `${pathPrefix}.aliases`, code: "INVALID_TYPE", message: "aliases must be an array of strings." });
  } else if (aliases.length > GLOSSARY_LIMITS.maxAliasesPerEntry) {
    issues.push({ path: `${pathPrefix}.aliases`, code: "LIMIT_EXCEEDED", message: "aliases contains too many values." });
  }
  aliases.forEach((alias, aliasIndex) => {
    if (!alias.trim()) {
      issues.push({ path: `${pathPrefix}.aliases[${aliasIndex}]`, code: "EMPTY_VALUE", message: "alias must not be empty." });
    } else if (codePointLength(alias) > GLOSSARY_LIMITS.maxTermCodePoints) {
      issues.push({ path: `${pathPrefix}.aliases[${aliasIndex}]`, code: "LIMIT_EXCEEDED", message: "alias is too long." });
    }
  });

  if (typeof input.definition !== "string") {
    issues.push({ path: `${pathPrefix}.definition`, code: "INVALID_TYPE", message: "definition must be a string." });
  } else if (!definition.trim()) {
    issues.push({ path: `${pathPrefix}.definition`, code: "EMPTY_VALUE", message: "definition must not be empty." });
  } else if (codePointLength(definition) > GLOSSARY_LIMITS.maxDefinitionCodePoints) {
    issues.push({ path: `${pathPrefix}.definition`, code: "LIMIT_EXCEEDED", message: "definition is too long." });
  }

  return { entry: { term, aliases, definition }, issues };
}

function validateEntries(inputs: readonly GlossaryEntryInput[]): {
  entries: GlossaryEntry[];
  issues: GlossaryValidationIssue[];
} {
  const issues: GlossaryValidationIssue[] = [];
  if (inputs.length > GLOSSARY_LIMITS.maxEntries) {
    issues.push({ path: "entries", code: "LIMIT_EXCEEDED", message: "Glossary contains too many entries." });
  }
  const entries = inputs.map((input, index) => {
    const validated = validateEntry(input, index);
    issues.push(...validated.issues);
    return validated.entry;
  });

  const owners = new Map<string, string>();
  entries.forEach((entry, entryIndex) => {
    [entry.term, ...entry.aliases].forEach((displayValue, valueIndex) => {
      const normalized = normalizeGlossaryLookup(displayValue);
      if (!normalized) {
        return;
      }
      const valuePath = valueIndex === 0
        ? `entries[${entryIndex}].term`
        : `entries[${entryIndex}].aliases[${valueIndex - 1}]`;
      const existing = owners.get(normalized);
      if (existing) {
        issues.push({
          path: valuePath,
          code: "AMBIGUOUS_LOOKUP",
          message: `Normalized term or alias conflicts with ${existing}.`,
        });
      } else {
        owners.set(normalized, valuePath);
      }
    });
  });

  return { entries, issues };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKeys(value: Record<string, unknown>, supportedKeys: readonly string[]): string[] {
  const supported = new Set(supportedKeys);
  return Object.keys(value).filter((key) => !supported.has(key));
}

export function parseGlossaryDocument(raw: string): GlossarySnapshot {
  const revision = rawRevision(raw);
  if (Buffer.byteLength(raw, "utf8") > GLOSSARY_LIMITS.maxFileBytes) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: [{ path: "$", code: "LIMIT_EXCEEDED", message: "Glossary file is too large." }],
    };
  }

  const document = parseDocument(raw, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: document.errors.map((error) => ({ path: "$", code: "INVALID_YAML", message: error.message })),
    };
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: [{ path: "$", code: "INVALID_YAML", message: error instanceof Error ? error.message : "YAML conversion failed." }],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: [{ path: "$", code: "INVALID_DOCUMENT", message: "Glossary document must be an object." }],
    };
  }

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== GLOSSARY_SCHEMA_VERSION) {
    return {
      status: "unsupported",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      schemaVersion: typeof schemaVersion === "number" || typeof schemaVersion === "string" ? schemaVersion : null,
      issues: [{ path: "schemaVersion", code: "UNSUPPORTED_SCHEMA", message: "Unsupported glossary schemaVersion." }],
    };
  }

  const issues: GlossaryValidationIssue[] = unknownKeys(parsed, ["schemaVersion", "entries"])
    .map((key) => ({ path: key, code: "UNKNOWN_FIELD", message: `Unknown document field: ${key}.` }));
  if (!Array.isArray(parsed.entries)) {
    issues.push({ path: "entries", code: "INVALID_TYPE", message: "entries must be an array." });
    return { status: "invalid", relativePath: GLOSSARY_RELATIVE_PATH, revision, issues };
  }

  const inputs: GlossaryEntryInput[] = parsed.entries.map((candidate, index) => {
    if (!isPlainObject(candidate)) {
      issues.push({ path: `entries[${index}]`, code: "INVALID_ENTRY", message: "Entry must be an object." });
      return { term: "", aliases: [], definition: "" };
    }
    unknownKeys(candidate, ["term", "aliases", "definition"]).forEach((key) => {
      issues.push({ path: `entries[${index}].${key}`, code: "UNKNOWN_FIELD", message: `Unknown entry field: ${key}.` });
    });
    return candidate as unknown as GlossaryEntryInput;
  });
  const validated = validateEntries(inputs);
  issues.push(...validated.issues);
  if (issues.length > 0) {
    return { status: "invalid", relativePath: GLOSSARY_RELATIVE_PATH, revision, issues };
  }
  return {
    status: "valid",
    relativePath: GLOSSARY_RELATIVE_PATH,
    revision,
    entries: validated.entries.map(cloneEntry),
  };
}

export function serializeGlossaryDocument(entries: readonly GlossaryEntry[]): string {
  const raw = stringify(
    {
      schemaVersion: GLOSSARY_SCHEMA_VERSION,
      entries: entries.map((entry) => ({
        term: entry.term,
        ...(entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}),
        definition: entry.definition,
      })),
    },
    { lineWidth: 0 },
  );
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function assertValidEntries(inputs: readonly GlossaryEntryInput[]): GlossaryEntry[] {
  const validated = validateEntries(inputs);
  if (validated.issues.length > 0) {
    const limitExceeded = validated.issues.some((issue) => issue.code === "LIMIT_EXCEEDED");
    fail(
      limitExceeded ? "GLOSSARY_LIMIT_EXCEEDED" : "GLOSSARY_INVALID_REQUEST",
      "Glossary entry validation failed.",
      "none",
      false,
      validated.issues,
    );
  }
  return validated.entries;
}

function findEntryByLookup(entries: readonly GlossaryEntry[], value: string): {
  entry: GlossaryEntry;
  matchedText: string;
  index: number;
} | null {
  const normalized = normalizeGlossaryLookup(value);
  if (!normalized) {
    return null;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    for (const candidate of [entry.term, ...entry.aliases]) {
      if (normalizeGlossaryLookup(candidate) === normalized) {
        return { entry, matchedText: candidate, index };
      }
    }
  }
  return null;
}

function findEntryByCanonicalTerm(entries: readonly GlossaryEntry[], value: string): {
  entry: GlossaryEntry;
  index: number;
} | null {
  const normalized = normalizeGlossaryLookup(value);
  if (!normalized) {
    return null;
  }
  const index = entries.findIndex((entry) => normalizeGlossaryLookup(entry.term) === normalized);
  return index >= 0 ? { entry: entries[index], index } : null;
}

function validatePageRequest(request: GlossaryPageRequest = {}): { offset: number; pageSize: number } {
  const offset = request.offset ?? 0;
  const pageSize = request.pageSize ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail("GLOSSARY_INVALID_REQUEST", "offset must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GLOSSARY_LIMITS.maxPageSize) {
    fail("GLOSSARY_LIMIT_EXCEEDED", "pageSize is outside the supported range.");
  }
  return { offset, pageSize };
}

function publicSnapshot(read: InternalRead): GlossarySnapshot {
  switch (read.status) {
    case "missing":
      return { ...read };
    case "valid":
      return {
        status: "valid",
        relativePath: read.relativePath,
        revision: read.revision,
        entries: read.entries.map(cloneEntry),
      };
    case "invalid":
      return {
        status: "invalid",
        relativePath: read.relativePath,
        revision: read.revision,
        issues: read.issues.map((issue) => ({ ...issue })),
      };
    case "unsupported":
      return {
        status: "unsupported",
        relativePath: read.relativePath,
        revision: read.revision,
        schemaVersion: read.schemaVersion,
        issues: read.issues.map((issue) => ({ ...issue })),
      };
  }
}

async function safeOperation<T>(operation: () => Promise<T>): Promise<GlossaryOperationResult<T>> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GlossaryServiceFailure) {
      return error.error;
    }
    return operationError(
      "GLOSSARY_IO_ERROR",
      error instanceof Error ? error.message : "Glossary I/O failed.",
      "none",
      true,
    );
  }
}

export class GlossaryApplicationService {
  readonly #runGit: (cwd: string, args: readonly string[]) => Promise<string>;
  readonly #beforeRename?: GlossaryApplicationServiceDeps["beforeRename"];
  readonly #renamePath: (oldPath: string, newPath: string) => Promise<void>;

  constructor(deps: GlossaryApplicationServiceDeps = {}) {
    this.#runGit = deps.runGit ?? (async (cwd, args) => {
      const result = await execFileAsync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    });
    this.#beforeRename = deps.beforeRename;
    this.#renamePath = deps.renamePath ?? rename;
  }

  async resolvePrimaryCheckout(workspacePath: string): Promise<ResolvedGlossaryCheckout> {
    const normalizedWorkspacePath = workspacePath.trim();
    if (!normalizedWorkspacePath || !path.isAbsolute(normalizedWorkspacePath)) {
      fail("GLOSSARY_TARGET_INVALID", "Primary checkout workspacePath must be absolute.");
    }
    let gitRoot: string;
    try {
      gitRoot = await this.#runGit(normalizedWorkspacePath, ["rev-parse", "--show-toplevel"]);
    } catch {
      fail("GLOSSARY_TARGET_INVALID", "Primary workspace is not a supported Git checkout.");
    }
    const rootPath = path.resolve(gitRoot);
    const rootStats = await lstat(rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      fail("GLOSSARY_TARGET_INVALID", "Git checkout root must be a real directory.");
    }
    const rootRealPath = await realpath(rootPath);
    const gitMarkerStats = await lstat(path.join(rootPath, ".git"));
    if (gitMarkerStats.isSymbolicLink()) {
      fail("GLOSSARY_TARGET_INVALID", "Git checkout marker must not be a symbolic link or junction.");
    }
    return {
      rootPath,
      rootRealPath,
      rootIdentity: identityFromStats(rootStats),
      gitMarkerIdentity: identityFromStats(gitMarkerStats),
    };
  }

  async read(target: ResolvedGlossaryCheckout): Promise<GlossarySnapshot> {
    return publicSnapshot(await this.#readInternal(await this.#revalidateCheckout(target)));
  }

  async describeCheckout(target: ResolvedGlossaryCheckout): Promise<GlossaryCheckoutDisplay> {
    const current = await this.#revalidateCheckout(target);
    const branch = (await this.#runGit(current.rootPath, ["branch", "--show-current"])).trim();
    const pathLabel = path.basename(current.rootPath);
    return {
      repositoryName: pathLabel,
      branch: branch || "(detached HEAD)",
      pathLabel,
    };
  }

  async validate(target: ResolvedGlossaryCheckout): Promise<GlossaryValidationResult> {
    return { ok: true, snapshot: await this.read(target) };
  }

  async list(
    target: ResolvedGlossaryCheckout,
    request: GlossaryPageRequest = {},
  ): Promise<GlossaryOperationResult<GlossaryListResult>> {
    return safeOperation(async () => {
      const page = validatePageRequest(request);
      const snapshot = await this.#readUsable(target);
      const entries = snapshot.status === "missing" ? [] : snapshot.entries;
      return {
        ok: true,
        revision: snapshot.status === "missing" ? null : snapshot.revision,
        entries: entries.slice(page.offset, page.offset + page.pageSize).map(cloneEntry),
        total: entries.length,
        ...page,
      };
    });
  }

  async search(
    target: ResolvedGlossaryCheckout,
    request: GlossarySearchRequest,
  ): Promise<GlossaryOperationResult<GlossaryListResult>> {
    return safeOperation(async () => {
      if (typeof request?.query !== "string") {
        fail("GLOSSARY_INVALID_REQUEST", "query must be a string.");
      }
      if (codePointLength(request.query) > GLOSSARY_LIMITS.maxQueryCodePoints) {
        fail("GLOSSARY_LIMIT_EXCEEDED", "query is too long.");
      }
      const page = validatePageRequest(request);
      const snapshot = await this.#readUsable(target);
      const entries = snapshot.status === "missing" ? [] : snapshot.entries;
      const query = normalizeGlossaryLookup(request.query);
      const ranked = query
        ? entries
            .map((entry, index) => ({ entry, index, rank: this.#searchRank(entry, query) }))
            .filter((candidate) => candidate.rank !== null)
            .sort((left, right) => left.rank! - right.rank! || left.index - right.index)
            .map((candidate) => candidate.entry)
        : entries;
      return {
        ok: true,
        revision: snapshot.status === "missing" ? null : snapshot.revision,
        entries: ranked.slice(page.offset, page.offset + page.pageSize).map(cloneEntry),
        total: ranked.length,
        ...page,
      };
    });
  }

  async get(
    target: ResolvedGlossaryCheckout,
    termOrAlias: string,
  ): Promise<GlossaryOperationResult<GlossaryGetResult>> {
    return safeOperation(async () => {
      if (typeof termOrAlias !== "string" || !normalizeGlossaryLookup(termOrAlias)) {
        fail("GLOSSARY_INVALID_REQUEST", "termOrAlias must not be empty.");
      }
      const snapshot = await this.#readUsable(target);
      if (snapshot.status === "missing") {
        fail("GLOSSARY_NOT_FOUND", "Glossary entry was not found.");
      }
      const found = findEntryByLookup(snapshot.entries, termOrAlias);
      if (!found) {
        fail("GLOSSARY_NOT_FOUND", "Glossary entry was not found.");
      }
      return {
        ok: true,
        revision: snapshot.revision,
        matchedText: found.matchedText,
        entry: cloneEntry(found.entry),
      };
    });
  }

  async create(
    target: ResolvedGlossaryCheckout,
    request: GlossaryCreateRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(async () => {
      this.#validateCreateMode(request.mode, 1, request.proactiveCreateLimit);
      const [entry] = assertValidEntries([request.entry]);
      const previous = await this.#readMutable(target);
      if (previous.status === "valid") {
        const current = findEntryByCanonicalTerm(previous.entries, entry.term);
        if (current && exactEntryEqual(current.entry, entry)) {
          return this.#converged(previous);
        }
        if ([entry.term, ...entry.aliases].some((value) => findEntryByLookup(previous.entries, value))) {
          fail("GLOSSARY_CONFLICT", "Glossary term already exists with different content.");
        }
      }
      const previousEntries = previous.status === "valid" ? previous.entries : [];
      const entries = assertValidEntries([...previousEntries, entry]);
      return this.#commit(target, guard, {
        previous,
        entries,
        isConverged: (snapshot) => snapshot.status === "valid"
          && Boolean(findEntryByCanonicalTerm(snapshot.entries, entry.term))
          && exactEntryEqual(findEntryByCanonicalTerm(snapshot.entries, entry.term)!.entry, entry),
      });
    });
  }

  async createBatch(
    target: ResolvedGlossaryCheckout,
    request: GlossaryCreateBatchRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(async () => {
      if (!Array.isArray(request.entries) || request.entries.length < 1) {
        fail("GLOSSARY_INVALID_REQUEST", "create-batch requires at least one entry.");
      }
      if (request.entries.length > GLOSSARY_LIMITS.maxBatchEntries) {
        fail("GLOSSARY_LIMIT_EXCEEDED", "create-batch contains too many entries.");
      }
      this.#validateCreateMode(request.mode, request.entries.length, request.proactiveCreateLimit);
      const requested = assertValidEntries(request.entries);
      const previous = await this.#readMutable(target);
      const previousEntries = previous.status === "valid" ? previous.entries : [];
      const exactMatches = requested.map((entry) => {
        const current = findEntryByCanonicalTerm(previousEntries, entry.term);
        return Boolean(current && exactEntryEqual(current.entry, entry));
      });
      if (exactMatches.every(Boolean)) {
        return this.#converged(previous as ValidRead);
      }
      if (exactMatches.some(Boolean)) {
        fail("GLOSSARY_CONFLICT", "create-batch only partially matches the current glossary.");
      }
      requested.forEach((entry) => {
        if ([entry.term, ...entry.aliases].some((value) => findEntryByLookup(previousEntries, value))) {
          fail("GLOSSARY_CONFLICT", "create-batch conflicts with an existing glossary entry.");
        }
      });
      const entries = assertValidEntries([...previousEntries, ...requested]);
      return this.#commit(target, guard, {
        previous,
        entries,
        isConverged: (snapshot) => {
          if (snapshot.status !== "valid") {
            return false;
          }
          const matches = requested.map((entry) => {
            const current = findEntryByCanonicalTerm(snapshot.entries, entry.term);
            return Boolean(current && exactEntryEqual(current.entry, entry));
          });
          return matches.every(Boolean);
        },
      });
    });
  }

  async update(
    target: ResolvedGlossaryCheckout,
    request: GlossaryUpdateRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(async () => {
      this.#validateExpectedRevision(request.expectedRevision);
      const normalizedTarget = normalizeGlossaryLookup(request.targetTerm);
      if (!normalizedTarget) {
        fail("GLOSSARY_INVALID_REQUEST", "targetTerm must not be empty.");
      }
      const [replacement] = assertValidEntries([request.entry]);
      const previous = await this.#readMutable(target);
      if (previous.status === "missing") {
        fail("GLOSSARY_NOT_FOUND", "Glossary entry was not found.");
      }
      if (previous.revision !== request.expectedRevision) {
        if (this.#isUpdateConverged(previous, normalizedTarget, replacement)) {
          return this.#converged(previous);
        }
        fail("GLOSSARY_CONFLICT", "Glossary revision changed before update.");
      }
      const current = findEntryByCanonicalTerm(previous.entries, normalizedTarget);
      if (!current) {
        fail("GLOSSARY_NOT_FOUND", "Glossary canonical term was not found.");
      }
      const replacementCollides = [replacement.term, ...replacement.aliases].some((value) => {
        const resolved = findEntryByLookup(previous.entries, value);
        return Boolean(resolved && resolved.index !== current.index);
      });
      if (replacementCollides) {
        fail("GLOSSARY_CONFLICT", "Updated entry conflicts with another glossary entry.");
      }
      const entries = previous.entries.map((entry, index) => index === current.index ? replacement : entry);
      const validatedEntries = assertValidEntries(entries);
      return this.#commit(target, guard, {
        previous,
        entries: validatedEntries,
        isConverged: (snapshot) => snapshot.status === "valid"
          && this.#isUpdateConverged(snapshot, normalizedTarget, replacement),
      });
    });
  }

  async delete(
    target: ResolvedGlossaryCheckout,
    request: GlossaryDeleteRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(async () => {
      this.#validateExpectedRevision(request.expectedRevision);
      const normalizedTarget = normalizeGlossaryLookup(request.targetTerm);
      if (!normalizedTarget) {
        fail("GLOSSARY_INVALID_REQUEST", "targetTerm must not be empty.");
      }
      const previous = await this.#readMutable(target);
      if (previous.status === "missing") {
        return {
          ok: true,
          outcome: "converged",
          effect: "none",
          revision: null,
          entries: [],
        };
      }
      if (previous.revision !== request.expectedRevision) {
        if (this.#isDeleteConverged(previous, normalizedTarget)) {
          return this.#converged(previous);
        }
        fail("GLOSSARY_CONFLICT", "Glossary revision changed before delete.");
      }
      const current = findEntryByCanonicalTerm(previous.entries, normalizedTarget);
      if (!current) {
        fail("GLOSSARY_NOT_FOUND", "Glossary canonical term was not found.");
      }
      const entries = previous.entries.filter((_, index) => index !== current.index).map(cloneEntry);
      return this.#commit(target, guard, {
        previous,
        entries,
        isConverged: (snapshot) => snapshot.status === "valid"
          && this.#isDeleteConverged(snapshot, normalizedTarget),
      });
    });
  }

  async #readUsable(target: ResolvedGlossaryCheckout): Promise<MissingRead | ValidRead> {
    const read = await this.#readInternal(await this.#revalidateCheckout(target));
    if (read.status === "invalid") {
      fail("GLOSSARY_INVALID_FILE", "Glossary file is invalid.", "none", false, read.issues);
    }
    if (read.status === "unsupported") {
      fail("GLOSSARY_UNSUPPORTED_SCHEMA", "Glossary schemaVersion is unsupported.", "none", false, read.issues);
    }
    return read;
  }

  async #readMutable(target: ResolvedGlossaryCheckout): Promise<MissingRead | ValidRead> {
    return this.#readUsable(target);
  }

  async #readInternal(target: ResolvedGlossaryCheckout): Promise<InternalRead> {
    const glossaryPath = path.join(target.rootPath, ".withmate", "glossary.yaml");
    let pathStats: Awaited<ReturnType<typeof lstat>>;
    try {
      pathStats = await lstat(glossaryPath);
    } catch (error) {
      if (isMissingError(error)) {
        return { status: "missing", relativePath: GLOSSARY_RELATIVE_PATH, revision: null };
      }
      throw error;
    }
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      fail("GLOSSARY_TARGET_INVALID", "glossary.yaml must be a regular file and must not be a symbolic link or junction.");
    }
    const parent = await this.#inspectGlossaryDirectory(target, false);
    if (!parent) {
      fail("GLOSSARY_TARGET_CHANGED", "Glossary directory disappeared during read.");
    }
    const handle = await open(glossaryPath, "r");
    try {
      const openedStats = await handle.stat();
      if (!sameIdentity(identityFromStats(pathStats), identityFromStats(openedStats))) {
        fail("GLOSSARY_TARGET_CHANGED", "glossary.yaml changed before read.");
      }
      const isOversized = openedStats.size > GLOSSARY_LIMITS.maxFileBytes;
      const raw = isOversized ? "" : await handle.readFile({ encoding: "utf8" });
      const oversizedRevision = isOversized ? await hashFileHandle(handle) : null;
      const confirmedStats = await handle.stat();
      const confirmedPathStats = await lstat(glossaryPath);
      if (
        !sameIdentity(identityFromStats(openedStats), identityFromStats(confirmedStats))
        || !sameIdentity(identityFromStats(openedStats), identityFromStats(confirmedPathStats))
        || openedStats.size !== confirmedStats.size
        || openedStats.mtimeMs !== confirmedStats.mtimeMs
      ) {
        fail("GLOSSARY_TARGET_CHANGED", "glossary.yaml changed during read.");
      }
      if (isOversized) {
        return {
          status: "invalid",
          relativePath: GLOSSARY_RELATIVE_PATH,
          revision: oversizedRevision!,
          issues: [{ path: "$", code: "LIMIT_EXCEEDED", message: "Glossary file is too large." }],
          raw,
          fileIdentity: identityFromStats(openedStats),
        };
      }
      const parsed = parseGlossaryDocument(raw);
      return {
        ...parsed,
        raw,
        fileIdentity: identityFromStats(openedStats),
      } as InternalRead;
    } finally {
      await handle.close();
    }
  }

  async #revalidateCheckout(target: ResolvedGlossaryCheckout): Promise<ResolvedGlossaryCheckout> {
    const current = await this.resolvePrimaryCheckout(target.rootPath);
    if (!areResolvedGlossaryCheckoutsEqual(target, current)) {
      fail("GLOSSARY_TARGET_CHANGED", "Primary checkout identity changed.");
    }
    return current;
  }

  async #inspectGlossaryDirectory(
    target: ResolvedGlossaryCheckout,
    createIfMissing: boolean,
  ): Promise<DirectoryIdentity | null> {
    const directoryPath = path.join(target.rootPath, ".withmate");
    let directoryStats: Awaited<ReturnType<typeof lstat>>;
    try {
      directoryStats = await lstat(directoryPath);
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }
      if (!createIfMissing) {
        return null;
      }
      try {
        await mkdir(directoryPath);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      directoryStats = await lstat(directoryPath);
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      fail("GLOSSARY_TARGET_INVALID", ".withmate must be a real directory and must not be a symbolic link or junction.");
    }
    const directoryRealPath = await realpath(directoryPath);
    const relative = path.relative(target.rootRealPath, directoryRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("GLOSSARY_TARGET_INVALID", ".withmate resolves outside the primary checkout.");
    }
    return {
      path: directoryPath,
      realPath: directoryRealPath,
      identity: identityFromStats(directoryStats),
    };
  }

  async #runGuard(target: ResolvedGlossaryCheckout, guard?: GlossaryMutationGuard): Promise<void> {
    await this.#revalidateCheckout(target);
    if (guard) {
      const guardedTarget = await guard();
      if (!guardedTarget || !areResolvedGlossaryCheckoutsEqual(target, guardedTarget)) {
        fail("GLOSSARY_TARGET_CHANGED", "Runtime binding no longer authorizes this checkout.");
      }
    }
  }

  async #commit(
    target: ResolvedGlossaryCheckout,
    guard: GlossaryMutationGuard | undefined,
    plan: MutationPlan,
  ): Promise<GlossaryMutationResult> {
    const raw = serializeGlossaryDocument(plan.entries);
    if (Buffer.byteLength(raw, "utf8") > GLOSSARY_LIMITS.maxFileBytes) {
      fail("GLOSSARY_LIMIT_EXCEEDED", "Serialized glossary exceeds the file size limit.");
    }

    await this.#runGuard(target, guard);
    const directory = await this.#inspectGlossaryDirectory(target, true);
    if (!directory) {
      fail("GLOSSARY_IO_ERROR", "Glossary directory could not be created.");
    }
    await this.#runGuard(target, guard);
    const confirmedDirectory = await this.#inspectGlossaryDirectory(target, false);
    if (!confirmedDirectory || !sameIdentity(directory.identity, confirmedDirectory.identity)) {
      fail("GLOSSARY_TARGET_CHANGED", "Glossary directory identity changed before write.");
    }

    const targetPath = path.join(directory.path, "glossary.yaml");
    const temporaryPath = path.join(directory.path, `.glossary-${process.pid}-${randomUUID()}.tmp`);
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(raw, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;

      await this.#beforeRename?.(temporaryPath, targetPath);
      await this.#runGuard(target, guard);
      const beforeCommitDirectory = await this.#inspectGlossaryDirectory(target, false);
      if (!beforeCommitDirectory || !sameIdentity(directory.identity, beforeCommitDirectory.identity)) {
        fail("GLOSSARY_TARGET_CHANGED", "Glossary directory identity changed before commit.");
      }
      const current = await this.#readInternal(target);
      if (!this.#samePreMutationState(plan.previous, current)) {
        if (plan.isConverged(publicSnapshot(current))) {
          if (current.status !== "valid") {
            fail("GLOSSARY_CONFLICT", "Glossary changed before mutation.");
          }
          return this.#converged(current);
        }
        fail("GLOSSARY_CONFLICT", "Glossary changed before mutation.");
      }

      let renameError: unknown = null;
      try {
        await this.#renamePath(temporaryPath, targetPath);
      } catch (error) {
        renameError = error;
      }

      let after: InternalRead;
      try {
        after = await this.#readInternal(await this.#revalidateCheckout(target));
      } catch (error) {
        fail(
          "GLOSSARY_EFFECT_UNKNOWN",
          error instanceof Error ? error.message : "Glossary mutation effect could not be determined.",
          "unknown",
          false,
        );
      }
      if (after.status === "valid" && after.revision === rawRevision(raw)) {
        return {
          ok: true,
          outcome: "applied",
          effect: "applied",
          revision: after.revision,
          entries: after.entries.map(cloneEntry),
        };
      }
      if (this.#samePreMutationState(plan.previous, after)) {
        fail(
          renameError ? "GLOSSARY_IO_ERROR" : "GLOSSARY_CONFLICT",
          renameError instanceof Error ? renameError.message : "Glossary postcondition was not applied.",
          "none",
          Boolean(renameError),
        );
      }
      return fail(
        "GLOSSARY_EFFECT_UNKNOWN",
        "Glossary mutation effect could not be classified safely.",
        "unknown",
        false,
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  #samePreMutationState(previous: InternalRead, current: InternalRead): boolean {
    if (previous.status === "missing" || current.status === "missing") {
      return previous.status === "missing" && current.status === "missing";
    }
    return previous.revision === current.revision && sameIdentity(previous.fileIdentity, current.fileIdentity);
  }

  #converged(snapshot: ValidRead): GlossaryMutationResult {
    return {
      ok: true,
      outcome: "converged",
      effect: "none",
      revision: snapshot.revision,
      entries: snapshot.entries.map(cloneEntry),
    };
  }

  #validateCreateMode(mode: string, count: number, proactiveCreateLimit: number | null | undefined): void {
    if (mode !== "explicit" && mode !== "proactive") {
      fail("GLOSSARY_INVALID_REQUEST", "create mode must be explicit or proactive.");
    }
    if (mode === "proactive") {
      if (
        !Number.isInteger(proactiveCreateLimit)
        || proactiveCreateLimit === null
        || proactiveCreateLimit === undefined
        || proactiveCreateLimit < 0
        || proactiveCreateLimit > 100
      ) {
        fail("GLOSSARY_INVALID_REQUEST", "A valid proactive create limit is required.");
      }
      if (proactiveCreateLimit === 0 || count > proactiveCreateLimit) {
        fail("GLOSSARY_LIMIT_EXCEEDED", "Proactive create is disabled or exceeds the configured limit.");
      }
    }
  }

  #validateExpectedRevision(value: string): void {
    if (typeof value !== "string" || !NORMALIZED_REVISION_PATTERN.test(value)) {
      fail("GLOSSARY_INVALID_REQUEST", "expectedRevision must be a glossary raw content hash.");
    }
  }

  #isUpdateConverged(
    snapshot: Extract<GlossarySnapshot, { status: "valid" }>,
    previousTerm: string,
    replacement: GlossaryEntry,
  ): boolean {
    const desired = findEntryByCanonicalTerm(snapshot.entries, replacement.term);
    if (!desired || !exactEntryEqual(desired.entry, replacement)) {
      return false;
    }
    const oldResolution = findEntryByLookup(snapshot.entries, previousTerm);
    return !oldResolution || oldResolution.index === desired.index;
  }

  #isDeleteConverged(
    snapshot: Extract<GlossarySnapshot, { status: "valid" }>,
    targetTerm: string,
  ): boolean {
    return findEntryByLookup(snapshot.entries, targetTerm) === null;
  }

  #searchRank(entry: GlossaryEntry, query: string): number | null {
    const term = normalizeGlossaryLookup(entry.term);
    const aliases = entry.aliases.map(normalizeGlossaryLookup);
    if (term === query) return 0;
    if (aliases.some((alias) => alias === query)) return 1;
    if (term.startsWith(query) || aliases.some((alias) => alias.startsWith(query))) return 2;
    if (term.includes(query) || aliases.some((alias) => alias.includes(query))) return 3;
    if (normalizeGlossaryLookup(entry.definition).includes(query)) return 4;
    return null;
  }
}
