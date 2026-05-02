import type { AuditLogEntry } from "../src/app-state.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

type AuditLogServiceStorage = {
  listSessionAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]>;
  createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLog(id: number, input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
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

  public clearAuditLogs(): Awaitable<void> {
    return this.storage.clearAuditLogs();
  }
}
