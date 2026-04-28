import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { CREATE_V2_SCHEMA_SQL } from "../src-electron/database-schema-v2.js";
import { AuditLogStorageV2Read } from "../src-electron/audit-log-storage-v2-read.js";
import { SessionStorageV2Read } from "../src-electron/session-storage-v2-read.js";
import type { Session } from "../src/session-state.js";

export type BenchmarkProfileName = "small" | "medium" | "large";

export type DataLoadingBenchmarkOptions = {
  outputPath?: string;
  overwrite?: boolean;
  keepDatabase?: boolean;
  sessions?: number;
  messagesPerSession?: number;
  auditLogsPerSession?: number;
  artifactEvery?: number;
  operationCount?: number;
  rawItemCount?: number;
};

export type DataLoadingBenchmarkResult = {
  dbPath: string;
  generated: {
    sessions: number;
    messages: number;
    messageArtifacts: number;
    auditLogs: number;
    auditOperations: number;
    rawItems: number;
    dbBytes: number;
  };
  timingsMs: {
    generateDatabase: number;
    listSessionSummaries: number;
    hydrateFirstSession: number;
    hydrateMiddleSession: number;
    auditSummaryFirstPage: number;
    auditDetailFirstEntry: number;
  };
  sample: {
    sessionSummaryCount: number;
    firstSessionMessageCount: number;
    middleSessionMessageCount: number;
    firstAuditPageCount: number;
    firstAuditDetailOperationCount: number;
  };
};

type ResolvedBenchmarkOptions = Required<Omit<DataLoadingBenchmarkOptions, "outputPath">> & {
  outputPath: string;
};

const PROFILE_DEFAULTS: Record<BenchmarkProfileName, Omit<ResolvedBenchmarkOptions, "outputPath" | "overwrite" | "keepDatabase">> = {
  small: {
    sessions: 10,
    messagesPerSession: 20,
    auditLogsPerSession: 5,
    artifactEvery: 5,
    operationCount: 2,
    rawItemCount: 4,
  },
  medium: {
    sessions: 80,
    messagesPerSession: 120,
    auditLogsPerSession: 25,
    artifactEvery: 8,
    operationCount: 3,
    rawItemCount: 8,
  },
  large: {
    sessions: 200,
    messagesPerSession: 500,
    auditLogsPerSession: 100,
    artifactEvery: 10,
    operationCount: 5,
    rawItemCount: 16,
  },
};

function nowIso(index: number): string {
  return new Date(Date.UTC(2026, 3, 28, 0, 0, index)).toISOString();
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function createDefaultOutputPath(): Promise<string> {
  const dirPath = await mkdtemp(resolve(tmpdir(), "withmate-data-loading-benchmark-"));
  return resolve(dirPath, "withmate-v2.db");
}

async function resolveOptions(options: DataLoadingBenchmarkOptions): Promise<ResolvedBenchmarkOptions> {
  const defaults = PROFILE_DEFAULTS.medium;
  return {
    outputPath: options.outputPath ? resolve(options.outputPath) : await createDefaultOutputPath(),
    overwrite: options.overwrite ?? false,
    keepDatabase: options.keepDatabase ?? false,
    sessions: positiveInteger(options.sessions, defaults.sessions),
    messagesPerSession: positiveInteger(options.messagesPerSession, defaults.messagesPerSession),
    auditLogsPerSession: positiveInteger(options.auditLogsPerSession, defaults.auditLogsPerSession),
    artifactEvery: positiveInteger(options.artifactEvery, defaults.artifactEvery),
    operationCount: positiveInteger(options.operationCount, defaults.operationCount),
    rawItemCount: positiveInteger(options.rawItemCount, defaults.rawItemCount),
  };
}

function ensureFreshDatabase(dbPath: string, overwrite: boolean): void {
  if (!existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
    return;
  }
  if (!overwrite) {
    throw new Error(`出力先 DB が既に存在するよ: ${dbPath}`);
  }
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function createSchema(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function createSession(sessionIndex: number, options: ResolvedBenchmarkOptions): Session {
  const messages = Array.from({ length: options.messagesPerSession }, (_, messageIndex) => {
    const role: "user" | "assistant" = messageIndex % 2 === 0 ? "user" : "assistant";
    const artifact = role === "assistant" && messageIndex % options.artifactEvery === 1
      ? {
          title: `artifact ${sessionIndex}-${messageIndex}`,
          activitySummary: [
            `session ${sessionIndex}`,
            `message ${messageIndex}`,
          ],
          operationTimeline: Array.from({ length: options.operationCount }, (_, operationIndex) => ({
            type: "tool",
            summary: `operation ${operationIndex}`,
            details: `operation detail ${operationIndex} ${"x".repeat(80)}`,
          })),
          changedFiles: [
            {
              kind: "edit" as const,
              path: `src/generated/file-${sessionIndex}-${messageIndex}.ts`,
              summary: "benchmark fixture",
              diffRows: Array.from({ length: 12 }, (_, diffIndex) => ({
                kind: diffIndex % 3 === 0 ? "add" as const : "context" as const,
                leftNumber: diffIndex,
                rightNumber: diffIndex + 1,
                leftText: `before ${diffIndex} ${"x".repeat(80)}`,
                rightText: `after ${diffIndex} ${"x".repeat(80)}`,
              })),
            },
          ],
          runChecks: [{ label: "test", value: "pass" }],
        }
      : undefined;

    return {
      role,
      text: `${role} message ${sessionIndex}-${messageIndex} ${"body ".repeat(24)}`,
      accent: messageIndex % 17 === 0,
      artifact,
    };
  });

  return {
    id: `benchmark-session-${sessionIndex}`,
    taskTitle: `benchmark session ${sessionIndex}`,
    taskSummary: `summary ${sessionIndex}`,
    status: "saved",
    updatedAt: nowIso(sessionIndex),
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "benchmark",
    workspacePath: "benchmark-workspace",
    branch: "benchmark",
    sessionKind: "default",
    characterId: "benchmark-character",
    character: "Benchmark Character",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    runState: "idle",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: `benchmark-thread-${sessionIndex}`,
    messages,
    stream: [],
  };
}

function countArtifactsPerSession(options: ResolvedBenchmarkOptions): number {
  let count = 0;
  for (let messageIndex = 0; messageIndex < options.messagesPerSession; messageIndex += 1) {
    if (messageIndex % 2 === 1 && messageIndex % options.artifactEvery === 1) {
      count += 1;
    }
  }
  return count;
}

function createAuditLog(auditStorage: AuditLogStorageV2Read, sessionId: string, sessionIndex: number, auditIndex: number, options: ResolvedBenchmarkOptions): void {
  auditStorage.createAuditLog({
    sessionId,
    createdAt: nowIso(sessionIndex * options.auditLogsPerSession + auditIndex),
    phase: auditIndex % 5 === 0 ? "running" : "completed",
    provider: "codex",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    approvalMode: "never",
    threadId: `thread-${sessionIndex}-${auditIndex}`,
    logicalPrompt: {
      systemText: `system ${"x".repeat(240)}`,
      inputText: `input ${"x".repeat(480)}`,
      composedText: `composed ${"x".repeat(960)}`,
    },
    transportPayload: {
      summary: "benchmark payload",
      fields: [{ label: "prompt", value: "x".repeat(512) }],
    },
    assistantText: `assistant response ${"x".repeat(1200)}`,
    operations: Array.from({ length: options.operationCount }, (_, operationIndex) => ({
      type: operationIndex % 2 === 0 ? "tool" : "analysis",
      summary: `operation ${operationIndex}`,
      details: `operation detail ${operationIndex} ${"x".repeat(320)}`,
    })),
    rawItemsJson: JSON.stringify(Array.from({ length: options.rawItemCount }, (_, rawIndex) => ({
      type: "message",
      id: `raw-${sessionIndex}-${auditIndex}-${rawIndex}`,
      text: "x".repeat(240),
    }))),
    usage: {
      inputTokens: 1000 + auditIndex,
      cachedInputTokens: 100,
      outputTokens: 300 + auditIndex,
    },
    errorMessage: "",
  });
}

function timed<T>(runner: () => T): { value: T; durationMs: number } {
  const startedAt = performance.now();
  const value = runner();
  return { value, durationMs: performance.now() - startedAt };
}

function roundDuration(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export async function runDataLoadingBenchmark(options: DataLoadingBenchmarkOptions = {}): Promise<DataLoadingBenchmarkResult> {
  const resolved = await resolveOptions(options);
  ensureFreshDatabase(resolved.outputPath, resolved.overwrite);

  const generation = timed(() => {
    createSchema(resolved.outputPath);
    const sessionStorage = new SessionStorageV2Read(resolved.outputPath);
    const auditStorage = new AuditLogStorageV2Read(resolved.outputPath);

    for (let sessionIndex = 0; sessionIndex < resolved.sessions; sessionIndex += 1) {
      const session = createSession(sessionIndex, resolved);
      sessionStorage.upsertSession(session);
      for (let auditIndex = 0; auditIndex < resolved.auditLogsPerSession; auditIndex += 1) {
        createAuditLog(auditStorage, session.id, sessionIndex, auditIndex, resolved);
      }
    }
  });

  const sessionStorage = new SessionStorageV2Read(resolved.outputPath);
  const auditStorage = new AuditLogStorageV2Read(resolved.outputPath);

  const summaries = timed(() => sessionStorage.listSessionSummaries());
  const firstSessionId = summaries.value[0]?.id ?? "benchmark-session-0";
  const middleSessionId = summaries.value[Math.floor(summaries.value.length / 2)]?.id ?? firstSessionId;
  const firstSession = timed(() => sessionStorage.getSession(firstSessionId));
  const middleSession = timed(() => sessionStorage.getSession(middleSessionId));
  const auditPage = timed(() => auditStorage.listSessionAuditLogSummaryPage(firstSessionId, { cursor: 0, limit: 50 }));
  const firstAuditId = auditPage.value.entries[0]?.id ?? -1;
  const auditDetail = timed(() => auditStorage.getSessionAuditLogDetail(firstSessionId, firstAuditId));

  const messageArtifacts = resolved.sessions * countArtifactsPerSession(resolved);
  return {
    dbPath: resolved.outputPath,
    generated: {
      sessions: resolved.sessions,
      messages: resolved.sessions * resolved.messagesPerSession,
      messageArtifacts,
      auditLogs: resolved.sessions * resolved.auditLogsPerSession,
      auditOperations: resolved.sessions * resolved.auditLogsPerSession * resolved.operationCount,
      rawItems: resolved.sessions * resolved.auditLogsPerSession * resolved.rawItemCount,
      dbBytes: statSync(resolved.outputPath).size,
    },
    timingsMs: {
      generateDatabase: roundDuration(generation.durationMs),
      listSessionSummaries: roundDuration(summaries.durationMs),
      hydrateFirstSession: roundDuration(firstSession.durationMs),
      hydrateMiddleSession: roundDuration(middleSession.durationMs),
      auditSummaryFirstPage: roundDuration(auditPage.durationMs),
      auditDetailFirstEntry: roundDuration(auditDetail.durationMs),
    },
    sample: {
      sessionSummaryCount: summaries.value.length,
      firstSessionMessageCount: firstSession.value?.messages.length ?? 0,
      middleSessionMessageCount: middleSession.value?.messages.length ?? 0,
      firstAuditPageCount: auditPage.value.entries.length,
      firstAuditDetailOperationCount: auditDetail.value?.operations.length ?? 0,
    },
  };
}

export function parseBenchmarkArgs(args: string[]): DataLoadingBenchmarkOptions {
  const options: DataLoadingBenchmarkOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--profile" && next) {
      if (next !== "small" && next !== "medium" && next !== "large") {
        throw new Error("--profile は small / medium / large のいずれかを指定してね。");
      }
      Object.assign(options, PROFILE_DEFAULTS[next]);
      index += 1;
    } else if (arg === "--out" && next) {
      options.outputPath = next;
      options.keepDatabase = true;
      index += 1;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--keep") {
      options.keepDatabase = true;
    } else if (arg === "--sessions" && next) {
      options.sessions = Number(next);
      index += 1;
    } else if (arg === "--messages" && next) {
      options.messagesPerSession = Number(next);
      index += 1;
    } else if (arg === "--audit-logs" && next) {
      options.auditLogsPerSession = Number(next);
      index += 1;
    } else if (arg === "--artifact-every" && next) {
      options.artifactEvery = Number(next);
      index += 1;
    } else if (arg === "--operations" && next) {
      options.operationCount = Number(next);
      index += 1;
    } else if (arg === "--raw-items" && next) {
      options.rawItemCount = Number(next);
      index += 1;
    } else {
      throw new Error(`未知の引数だよ: ${arg}`);
    }
  }
  return options;
}

function printResult(result: DataLoadingBenchmarkResult): void {
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const result = await runDataLoadingBenchmark(options);
  printResult(result);
  if (!options.keepDatabase && !options.outputPath) {
    rmSync(dirname(result.dbPath), { recursive: true, force: true });
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
