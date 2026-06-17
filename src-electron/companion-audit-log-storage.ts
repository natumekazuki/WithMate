import {
  CompanionAuditLogStorageV3,
  V4_COMPANION_AUDIT_LIVE_BLOB_REF_QUERIES,
} from "./companion-audit-log-storage-v3.js";

export class CompanionAuditLogStorage extends CompanionAuditLogStorageV3 {
  constructor(dbPath: string, blobRootPath: string) {
    super(dbPath, blobRootPath, V4_COMPANION_AUDIT_LIVE_BLOB_REF_QUERIES);
  }
}
