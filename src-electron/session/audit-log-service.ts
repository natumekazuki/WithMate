import type { AuditLogEntry, AuditLogProgressAck, AuditLogProgressPatch } from "../../src-shared/session/runtime-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

type AuditLogServiceStorage = {
  listSessionAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]>;
  createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLog(id: number, input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLogProgress?(id: number, patch: AuditLogProgressPatch): Awaitable<AuditLogProgressAck>;
  clearAuditLogs(): Awaitable<void>;
};

export class AuditLogService {
  public constructor(private readonly storage: AuditLogServiceStorage) {}

  public listSessionAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]> {
    return this.storage.listSessionAuditLogs(sessionId);
  }

  public createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry> {
    return this.storage.createAuditLog(input);
  }

  public updateAuditLog(id: number, input: CreateAuditLogInput): Awaitable<AuditLogEntry> {
    return this.storage.updateAuditLog(id, input);
  }

  public updateAuditLogProgress(id: number, patch: AuditLogProgressPatch): Awaitable<AuditLogProgressAck> {
    if (!this.storage.updateAuditLogProgress) throw new Error("Audit progress updates require V6 storage.");
    return this.storage.updateAuditLogProgress(id, patch);
  }

  public clearAuditLogs(): Awaitable<void> {
    return this.storage.clearAuditLogs();
  }
}
