import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

import type { ApplicationRunOutputDestinationGrant } from "../shared/application-run-output-model.js";

export type RunOutputExportFailureCode =
  "destination_exists" | "destination_invalid" | "integrity_mismatch" | "filesystem_failure";

export type RunOutputPublicationOutcome =
  | Readonly<{ status: "published"; cleanupPending: boolean }>
  | Readonly<{
      status: "not_published";
      code: RunOutputExportFailureCode;
      temporaryCleanup: "complete" | "pending";
    }>
  | Readonly<{ status: "unknown" }>;

export interface RunOutputExportWriter {
  write(bytes: ArrayBuffer): Promise<void>;
  finish(): Promise<RunOutputPublicationOutcome>;
  abort(): Promise<RunOutputPublicationOutcome>;
}

export type RunOutputExportPrepareResult =
  | Readonly<{ status: "ready"; writer: RunOutputExportWriter }>
  | Exclude<RunOutputPublicationOutcome, Readonly<{ status: "published" }>>;

export interface RunOutputExporterPort {
  prepare(
    grant: ApplicationRunOutputDestinationGrant,
    expected: Readonly<{ byteLength: number; contentSha256: string }>,
    signal?: AbortSignal,
  ): Promise<RunOutputExportPrepareResult>;
}

export type ProcessRunOutputExporterOptions = Readonly<{
  executablePath?: string;
  helperUrl?: URL;
  environment?: NodeJS.ProcessEnv;
  abortGraceMs?: number;
}>;

const DEFAULT_ABORT_GRACE_MS = 250;
const MAX_ABORT_GRACE_MS = 10_000;

export class ProcessRunOutputExporter implements RunOutputExporterPort {
  readonly #executablePath: string;
  readonly #helperUrl: URL;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #abortGraceMs: number;

  constructor(options: ProcessRunOutputExporterOptions = {}) {
    this.#executablePath = options.executablePath ?? process.execPath;
    this.#helperUrl = options.helperUrl ?? new URL("./run-output-export-helper.js", import.meta.url);
    this.#environment = options.environment ?? process.env;
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    if (
      !Number.isSafeInteger(this.#abortGraceMs) ||
      this.#abortGraceMs < 0 ||
      this.#abortGraceMs > MAX_ABORT_GRACE_MS
    ) {
      throw new RangeError("Run output export abort grace is invalid.");
    }
  }

  async prepare(
    grant: ApplicationRunOutputDestinationGrant,
    expected: Readonly<{ byteLength: number; contentSha256: string }>,
    signal?: AbortSignal,
  ): Promise<RunOutputExportPrepareResult> {
    if (
      grant.kind !== "explicit_absolute_path" ||
      grant.authority !== "cli_user_selection" ||
      !path.isAbsolute(grant.absolutePath) ||
      !Number.isSafeInteger(expected.byteLength) ||
      expected.byteLength < 0 ||
      !/^[0-9a-f]{64}$/u.test(expected.contentSha256)
    ) {
      return { status: "not_published", code: "destination_invalid", temporaryCleanup: "complete" };
    }
    if (signal?.aborted) {
      return { status: "not_published", code: "filesystem_failure", temporaryCleanup: "complete" };
    }
    const requestedParent = path.dirname(grant.absolutePath);
    const destinationName = path.basename(grant.absolutePath);
    if (destinationName === "" || destinationName === "." || destinationName === "..") {
      return { status: "not_published", code: "destination_invalid", temporaryCleanup: "complete" };
    }
    const temporaryName = `.withmate-output-${randomUUID()}.tmp`;
    const child = spawn(
      this.#executablePath,
      [
        fileURLToPath(this.#helperUrl),
        temporaryName,
        destinationName,
        requestedParent,
        String(expected.byteLength),
        expected.contentSha256,
      ],
      {
        env: { ...this.#environment, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    const writer = new ProcessRunOutputExportWriter(child, this.#abortGraceMs);
    const onAbort = () => {
      void writer.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      return await writer.waitUntilReady();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

class ProcessRunOutputExportWriter implements RunOutputExportWriter {
  readonly #child: ChildProcess;
  readonly #abortGraceMs: number;
  readonly #ready: Promise<void>;
  readonly #outcome: Promise<RunOutputPublicationOutcome>;
  #resolveReady!: () => void;
  #resolveOutcome!: (outcome: RunOutputPublicationOutcome) => void;
  #phase: "starting" | "ready" | "publishing" | "done" = "starting";
  #settled = false;
  #controlClosed = false;
  #reportedOutcome: RunOutputPublicationOutcome | undefined;
  #stdoutBuffer = "";
  #forceKillTimer: NodeJS.Timeout | undefined;

  constructor(child: ChildProcess, abortGraceMs: number) {
    this.#child = child;
    this.#abortGraceMs = abortGraceMs;
    this.#ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#outcome = new Promise((resolve) => {
      this.#resolveOutcome = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (value: string) => this.#consumeOutput(value));
    child.on("error", () => this.#recordLoss());
    child.on("close", () => {
      this.#settle(this.#reportedOutcome ?? this.#lossOutcome());
    });
  }

  async waitUntilReady(): Promise<RunOutputExportPrepareResult> {
    const first = await Promise.race([
      this.#ready.then(() => ({ status: "ready", writer: this }) as const),
      this.#outcome,
    ]);
    return first.status === "published" ? { status: "unknown" } : first;
  }

  async write(bytes: ArrayBuffer): Promise<void> {
    if (this.#phase !== "ready" || this.#child.stdin === null || !this.#child.stdin.writable) {
      throw new RunOutputExporterPortError();
    }
    const payload = Buffer.from(new Uint8Array(bytes));
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin!.write(payload, (error) => (error === null || error === undefined ? resolve() : reject(error)));
    }).catch(() => {
      throw new RunOutputExporterPortError();
    });
  }

  async finish(): Promise<RunOutputPublicationOutcome> {
    if (this.#phase !== "ready" || this.#child.stdin === null) return this.#outcome;
    this.#child.stdin.end();
    return this.#outcome;
  }

  async abort(): Promise<RunOutputPublicationOutcome> {
    if (this.#settled) return this.#outcome;
    try {
      const control = this.#child.stdio[3] as Writable | null;
      if (!this.#controlClosed) {
        this.#controlClosed = true;
        control?.end("abort\n");
      }
      this.#child.stdin?.end();
    } catch {
      this.#forceKill();
    }
    this.#scheduleForceKill();
    return this.#outcome;
  }

  #consumeOutput(value: string): void {
    this.#stdoutBuffer += value;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#recordLoss();
        continue;
      }
      if (isRecord(message) && message.phase === "ready" && this.#phase === "starting") {
        this.#phase = "ready";
        this.#resolveReady();
      } else if (isRecord(message) && message.phase === "publishing" && this.#phase === "ready") {
        this.#phase = "publishing";
      } else if (isRecord(message) && "result" in message) {
        const outcome = decodeOutcome(message.result);
        if (outcome === undefined) this.#recordLoss();
        else this.#recordOutcome(outcome);
      } else {
        this.#recordLoss();
      }
    }
  }

  #recordOutcome(outcome: RunOutputPublicationOutcome): void {
    if (this.#settled || this.#reportedOutcome !== undefined) {
      this.#recordLoss();
      return;
    }
    this.#reportedOutcome = outcome;
    this.#phase = "done";
    this.#closeControl();
  }

  #recordLoss(): void {
    if (this.#settled) return;
    this.#reportedOutcome = this.#lossOutcome();
    this.#phase = "done";
    this.#closeControl();
    this.#child.stdin?.destroy();
    this.#forceKill();
  }

  #lossOutcome(): RunOutputPublicationOutcome {
    return this.#phase === "publishing"
      ? { status: "unknown" }
      : { status: "not_published", code: "filesystem_failure", temporaryCleanup: "pending" };
  }

  #settle(outcome: RunOutputPublicationOutcome): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#phase = "done";
    this.#clearForceKillTimer();
    this.#closeControl();
    this.#resolveOutcome(outcome);
  }

  #closeControl(): void {
    if (!this.#controlClosed) {
      this.#controlClosed = true;
      (this.#child.stdio[3] as Writable | null)?.end();
    }
  }

  #scheduleForceKill(): void {
    if (this.#forceKillTimer !== undefined || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#forceKillTimer = setTimeout(() => this.#forceKill(), this.#abortGraceMs);
  }

  #forceKill(): void {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    try {
      this.#child.kill("SIGKILL");
    } catch {
      // The close/error events remain the source of the public publication outcome.
    }
  }

  #clearForceKillTimer(): void {
    if (this.#forceKillTimer === undefined) return;
    clearTimeout(this.#forceKillTimer);
    this.#forceKillTimer = undefined;
  }
}

export class RunOutputExporterPortError extends Error {}

function decodeOutcome(value: unknown): RunOutputPublicationOutcome | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "published" && typeof value.cleanupPending === "boolean") {
    return { status: "published", cleanupPending: value.cleanupPending };
  }
  if (
    value.status === "not_published" &&
    (value.code === "destination_exists" ||
      value.code === "destination_invalid" ||
      value.code === "integrity_mismatch" ||
      value.code === "filesystem_failure") &&
    (value.temporaryCleanup === "complete" || value.temporaryCleanup === "pending")
  ) {
    return { status: "not_published", code: value.code, temporaryCleanup: value.temporaryCleanup };
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
