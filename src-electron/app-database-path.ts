import { existsSync } from "node:fs";
import path from "node:path";

import { APP_DATABASE_V1_FILENAME } from "./database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME, isValidV2Database } from "./database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, isValidV3Database } from "./database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME, isValidV4Database } from "./database-schema-v4.js";

function v3BlobRootPath(userDataPath: string): string {
  return path.join(userDataPath, "blobs", "v3");
}

export function resolveAppDatabasePath(userDataPath: string): string {
  const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
  if (existsSync(v4Path) && isValidV4Database(v4Path)) {
    return v4Path;
  }

  const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
  if (existsSync(v3Path) && isValidV3Database(v3Path)) {
    return v3Path;
  }

  const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
  if (existsSync(v2Path) && isValidV2Database(v2Path)) {
    return v2Path;
  }

  const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
  if (existsSync(v1Path)) {
    return v1Path;
  }

  return v4Path;
}

export async function resolveOrMigrateAppDatabasePath(userDataPath: string): Promise<string> {
  const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
  if (existsSync(v4Path)) {
    return v4Path;
  }

  const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
  if (existsSync(v3Path)) {
    await migrateV3ToV4(userDataPath, v3Path, v4Path);
    return v4Path;
  }

  const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
  if (existsSync(v2Path)) {
    await migrateV2ToV3(userDataPath, v2Path, v3Path);
    await migrateV3ToV4(userDataPath, v3Path, v4Path);
    return v4Path;
  }

  const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
  if (existsSync(v1Path)) {
    await migrateV1ToV2(v1Path, v2Path);
    await migrateV2ToV3(userDataPath, v2Path, v3Path);
    await migrateV3ToV4(userDataPath, v3Path, v4Path);
    return v4Path;
  }

  return v4Path;
}

async function migrateV1ToV2(v1Path: string, v2Path: string): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v1-to-v2.js");
  createMigrationWriteReport({
    v1DbPath: v1Path,
    v2DbPath: v2Path,
  });
}

async function migrateV2ToV3(userDataPath: string, v2Path: string, v3Path: string): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v2-to-v3.js");
  await createMigrationWriteReport({
    sourceDatabaseFile: v2Path,
    targetDatabaseFile: v3Path,
    blobRootPath: v3BlobRootPath(userDataPath),
  });
}

async function migrateV3ToV4(userDataPath: string, v3Path: string, v4Path: string): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v3-to-v4.js");
  await createMigrationWriteReport({
    sourceDatabaseFile: v3Path,
    targetDatabaseFile: v4Path,
    blobRootPath: v3BlobRootPath(userDataPath),
    userDataPath,
  });
}
