import type { AuditLogEntry } from "../src/app-state.js";
import { AuditLogStorage } from "./audit-log-storage.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

export class AuditLogService {
  public constructor(private readonly storage: AuditLogStorage) {}

  public listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    return this.storage.listSessionAuditLogs(sessionId);
  }

  public createAuditLog(input: CreateAuditLogInput): AuditLogEntry {
    return this.storage.createAuditLog(input);
  }

  public updateAuditLog(id: number, input: CreateAuditLogInput): AuditLogEntry {
    return this.storage.updateAuditLog(id, input);
  }

  public clearAuditLogs(): void {
    this.storage.clearAuditLogs();
  }
}
