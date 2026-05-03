import { existsSync } from "node:fs";
import path from "node:path";

import { APP_DATABASE_V1_FILENAME } from "./database-schema-v1.js";
import { APP_DATABASE_V2_FILENAME, isValidV2Database } from "./database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, isValidV3Database } from "./database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME, isValidV4Database } from "./database-schema-v4.js";

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

  return path.join(userDataPath, APP_DATABASE_V1_FILENAME);
}
