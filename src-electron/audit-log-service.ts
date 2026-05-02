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

  public async listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]> {
    return await this.storage.listSessionAuditLogs(sessionId);
  }

  public async createAuditLog(input: CreateAuditLogInput): Promise<AuditLogEntry> {
    return await this.storage.createAuditLog(input);
  }

  public async updateAuditLog(id: number, input: CreateAuditLogInput): Promise<AuditLogEntry> {
    return await this.storage.updateAuditLog(id, input);
  }

  public async clearAuditLogs(): Promise<void> {
    await this.storage.clearAuditLogs();
  }
}
