import { existsSync } from "node:fs";
import path from "node:path";

import { APP_DATABASE_V1_FILENAME } from "./database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME, isValidV2Database } from "./database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, isValidV3Database } from "./database-schema-v3.js";
import {
  APP_DATABASE_V4_FILENAME,
  APP_DATABASE_V4_SCHEMA_VERSION,
  isUnsupportedNewerV4Database,
  isValidV4Database,
  readV4DatabaseUserVersion,
} from "./database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  isValidV6Database,
} from "./database-schema-v6.js";

function v3BlobRootPath(userDataPath: string): string {
  return path.join(userDataPath, "blobs", "v3");
}

export type AppDatabaseMigrationProgress = {
  title: string;
  detail?: string;
};

type AppDatabaseMigrationProgressListener = (progress: AppDatabaseMigrationProgress) => void;

export function resolveAppDatabasePath(userDataPath: string): string {
  const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
  if (existsSync(v6Path) && isValidV6Database(v6Path)) {
    return v6Path;
  }

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

  return v6Path;
}

export async function resolveOrMigrateAppDatabasePath(
  userDataPath: string,
  onProgress?: AppDatabaseMigrationProgressListener,
): Promise<string> {
  const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
  onProgress?.({
    title: "データベースを確認しています",
    detail: `${APP_DATABASE_V6_FILENAME} を確認しています。`,
  });
  const v6Exists = existsSync(v6Path);
  if (v6Exists && isValidV6Database(v6Path)) {
    const v4PathForExistingV6 = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
    if (existsSync(v4PathForExistingV6) && isValidV4Database(v4PathForExistingV6)) {
      onProgress?.({
        title: "データベースを移行しています",
        detail: `${APP_DATABASE_V4_FILENAME} から ${APP_DATABASE_V6_FILENAME} へ継続データを移行しています。`,
      });
      await migrateV4ToV6(v4PathForExistingV6, v6Path);
    }
    return v6Path;
  }

  const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
  onProgress?.({
    title: "データベースを確認しています",
    detail: `${APP_DATABASE_V4_FILENAME} を確認しています。`,
  });
  const v4Exists = existsSync(v4Path);
  if (v4Exists && isValidV4Database(v4Path)) {
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V4_FILENAME} から ${APP_DATABASE_V6_FILENAME} へ移行しています。`,
    });
    await migrateV4ToV6(v4Path, v6Path, { overwrite: v6Exists });
    return v6Path;
  }
  if (v4Exists && isUnsupportedNewerV4Database(v4Path)) {
    const userVersion = readV4DatabaseUserVersion(v4Path);
    throw new Error(
      `${APP_DATABASE_V4_FILENAME} はこの WithMate が対応していない新しい DB バージョンです。`
      + ` user_version=${userVersion} は対応バージョン ${APP_DATABASE_V4_SCHEMA_VERSION} より新しいため、`
      + "legacy DB からの自動移行で上書きしません。",
    );
  }

  const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
  const v3Exists = existsSync(v3Path);
  if (v3Exists && isValidV3Database(v3Path)) {
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V3_FILENAME} から ${APP_DATABASE_V4_FILENAME} へ移行しています。`,
    });
    await migrateV3ToV4(userDataPath, v3Path, v4Path, { overwrite: v4Exists });
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V4_FILENAME} から ${APP_DATABASE_V6_FILENAME} へ移行しています。`,
    });
    await migrateV4ToV6(v4Path, v6Path, { overwrite: v6Exists });
    return v6Path;
  }

  const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
  const v2Exists = existsSync(v2Path);
  if (v2Exists && isValidV2Database(v2Path)) {
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V2_FILENAME} から ${APP_DATABASE_V3_FILENAME} へ移行しています。`,
    });
    await migrateV2ToV3(userDataPath, v2Path, v3Path, { overwrite: v3Exists });
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V3_FILENAME} から ${APP_DATABASE_V4_FILENAME} へ移行しています。`,
    });
    await migrateV3ToV4(userDataPath, v3Path, v4Path, { overwrite: v4Exists });
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V4_FILENAME} から ${APP_DATABASE_V6_FILENAME} へ移行しています。`,
    });
    await migrateV4ToV6(v4Path, v6Path, { overwrite: v6Exists });
    return v6Path;
  }

  const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
  if (existsSync(v1Path)) {
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V1_FILENAME} から ${APP_DATABASE_V2_FILENAME} へ移行しています。`,
    });
    await migrateV1ToV2(v1Path, v2Path, { overwrite: v2Exists });
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V2_FILENAME} から ${APP_DATABASE_V3_FILENAME} へ移行しています。`,
    });
    await migrateV2ToV3(userDataPath, v2Path, v3Path, { overwrite: v3Exists });
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V3_FILENAME} から ${APP_DATABASE_V4_FILENAME} へ移行しています。`,
    });
    await migrateV3ToV4(userDataPath, v3Path, v4Path, { overwrite: v4Exists });
    onProgress?.({
      title: "データベースを移行しています",
      detail: `${APP_DATABASE_V4_FILENAME} から ${APP_DATABASE_V6_FILENAME} へ移行しています。`,
    });
    await migrateV4ToV6(v4Path, v6Path, { overwrite: v6Exists });
    return v6Path;
  }

  const { createOrVerifyV6FreshDatabase } = await import("./app-database-v6-bootstrap.js");
  const fresh = await createOrVerifyV6FreshDatabase(userDataPath);
  return fresh.dbPath;
}

async function migrateV1ToV2(v1Path: string, v2Path: string, options: { overwrite?: boolean } = {}): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v1-to-v2.js");
  createMigrationWriteReport({
    v1DbPath: v1Path,
    v2DbPath: v2Path,
    overwrite: options.overwrite,
  });
}

async function migrateV2ToV3(
  userDataPath: string,
  v2Path: string,
  v3Path: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v2-to-v3.js");
  await createMigrationWriteReport({
    sourceDatabaseFile: v2Path,
    targetDatabaseFile: v3Path,
    blobRootPath: v3BlobRootPath(userDataPath),
    overwrite: options.overwrite,
  });
}

async function migrateV3ToV4(
  userDataPath: string,
  v3Path: string,
  v4Path: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v3-to-v4.js");
  await createMigrationWriteReport({
    sourceDatabaseFile: v3Path,
    targetDatabaseFile: v4Path,
    blobRootPath: v3BlobRootPath(userDataPath),
    userDataPath,
    overwrite: options.overwrite,
  });
}

async function migrateV4ToV6(
  v4Path: string,
  v6Path: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const { createMigrationWriteReport } = await import("../scripts/migrate-database-v4-to-v6.js");
  await createMigrationWriteReport({
    sourceDatabaseFile: v4Path,
    targetDatabaseFile: v6Path,
    overwrite: options.overwrite,
  });
}
