import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  ResourceBudgetError,
  type ResourceBudgetReservation,
  type ResourceBudgetStorage,
} from "./resource-budget-storage.js";

type StorageBudget = Pick<
  ResourceBudgetStorage,
  | "reserveStorage"
  | "resumeStorageReservation"
  | "consumeReservation"
  | "releaseReservation"
  | "markReservationForReconciliation"
  | "markStorageUnknown"
  | "reconcileCommitted"
>;

export type SessionFolderResourceBudgetDeps = {
  storage: StorageBudget;
  resolveSessionFilesDirectory(sessionId: string): string;
  listRootSessionIds(sessionId: string): readonly string[];
  now?(): Date;
};

export type SessionFolderResourceBudgetLease = {
  readonly reservation: ResourceBudgetReservation | null;
  readonly alreadyCommittedBytes: number;
  releaseLock(): void;
};

export class SessionFolderResourceBudget {
  private lockTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionFolderResourceBudgetDeps) {}

  async reserve(
    sessionId: string,
    bytes: number,
    operationId: string,
    resumed = false,
    alreadyCommittedBytes = 0,
  ): Promise<SessionFolderResourceBudgetLease> {
    const releaseLock = await this.acquireLock();
    try {
      await this.reconcileNow(sessionId, false);
      const now = this.now().toISOString();
      const reservation = bytes === 0
        ? null
        : resumed
          ? this.deps.storage.resumeStorageReservation({
            sessionId,
            bytes,
            alreadyCommittedBytes,
            operationId,
            resumedAt: now,
          })
          : this.deps.storage.reserveStorage({ sessionId, bytes, operationId, createdAt: now });
      return { reservation, alreadyCommittedBytes: resumed ? alreadyCommittedBytes : 0, releaseLock };
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  async settleApplied(
    sessionId: string,
    lease: SessionFolderResourceBudgetLease,
    actualBytes: number,
  ): Promise<void> {
    try {
      const settledAt = this.now().toISOString();
      if (lease.reservation) {
        this.deps.storage.consumeReservation(
          lease.reservation.reservationId,
          Math.max(0, actualBytes - lease.alreadyCommittedBytes),
          settledAt,
        );
      }
      await this.reconcileNow(sessionId, false);
    } finally {
      lease.releaseLock();
    }
  }

  release(lease: SessionFolderResourceBudgetLease): void {
    try {
      if (lease.reservation) {
        this.deps.storage.releaseReservation(lease.reservation.reservationId, this.now().toISOString());
      }
    } finally {
      lease.releaseLock();
    }
  }

  async reconcileRequired(
    sessionId: string,
    lease: SessionFolderResourceBudgetLease,
  ): Promise<void> {
    try {
      if (lease.reservation) {
        this.deps.storage.markReservationForReconciliation(
          lease.reservation.reservationId,
          this.now().toISOString(),
        );
      }
      await this.reconcileNow(sessionId, false);
    } finally {
      lease.releaseLock();
    }
  }

  async reconcile(sessionId: string): Promise<void> {
    const releaseLock = await this.acquireLock();
    try {
      await this.reconcileNow(sessionId, false);
    } finally {
      releaseLock();
    }
  }

  async reconcileAfterRestart(sessionId: string): Promise<void> {
    const releaseLock = await this.acquireLock();
    try {
      await this.reconcileNow(sessionId, true);
    } finally {
      releaseLock();
    }
  }

  private async reconcileNow(sessionId: string, releaseOpenReservations: boolean): Promise<void> {
    let totalBytes: number;
    try {
      totalBytes = await measureSessionFolders(
        this.deps.listRootSessionIds(sessionId),
        this.deps.resolveSessionFilesDirectory,
      );
    } catch {
      const observedAt = this.now().toISOString();
      this.deps.storage.markStorageUnknown({
        sessionId,
        idempotencyKey: `session-folder-scan-unknown:${randomUUID()}`,
        observedAt,
      });
      throw new ResourceBudgetError(
        "BUDGET_STORAGE_UNKNOWN",
        "The root SessionFolder storage usage could not be measured.",
        { reason: "scan_failed" },
      );
    }
    const reconciledAt = this.now().toISOString();
    const budget = this.deps.storage.reconcileCommitted({
      sessionId,
      dimension: "storageBytes",
      absoluteAmount: totalBytes,
      idempotencyKey: `session-folder-scan:${randomUUID()}`,
      reconciledAt,
      releaseOpenReservations,
    });
    const storage = budget.dimensions.storageBytes;
    if (storage.committed > storage.hardLimit) {
      throw new ResourceBudgetError(
        "BUDGET_HARD_LIMIT_EXCEEDED",
        "The root SessionFolder storage hard limit was exceeded.",
        { committed: storage.committed, hardLimit: storage.hardLimit },
      );
    }
  }

  private async acquireLock(): Promise<() => void> {
    const previous = this.lockTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lockTail = previous.then(() => current);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export async function measureSessionFolders(
  sessionIds: readonly string[],
  resolveSessionFilesDirectory: (sessionId: string) => string,
): Promise<number> {
  let totalBytes = 0;
  const seenFiles = new Set<string>();
  for (const sessionId of new Set(sessionIds)) {
    totalBytes = addSafe(
      totalBytes,
      await measureDirectory(resolveSessionFilesDirectory(sessionId), seenFiles),
    );
  }
  return totalBytes;
}

async function measureDirectory(directoryPath: string, seenFiles: Set<string>): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }

  let totalBytes = 0;
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      totalBytes = addSafe(totalBytes, await measureDirectory(entryPath, seenFiles));
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await lstat(entryPath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    if (stats.ino !== 0n) {
      const identity = `${stats.dev}:${stats.ino}`;
      if (seenFiles.has(identity)) continue;
      seenFiles.add(identity);
    }
    if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("A SessionFolder file exceeds the supported integer range.");
    }
    totalBytes = addSafe(totalBytes, Number(stats.size));
  }
  return totalBytes;
}

function addSafe(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("SessionFolder storage usage exceeds the supported integer range.");
  }
  return result;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}
