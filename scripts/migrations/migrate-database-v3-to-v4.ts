import { createMigrationDryRunReport, createMigrationWriteReport } from "../../src-electron/storage/migrations/migrate-database-v3-to-v4.js";

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/migrations/migrate-database-v3-to-v4.ts --dry-run --v3 <path-to-withmate-v3.db> [--blob-root <path-to-blobs>]\n"
      + "       npx tsx scripts/migrations/migrate-database-v3-to-v4.ts --write --v3 <path-to-withmate-v3.db> --v4 <path-to-withmate-v4.db> [--blob-root <path-to-blobs>] [--overwrite]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const source = value("--v3");
const blobRootPath = value("--blob-root");
if (!source) {
  usage();
}
if (args.includes("--dry-run")) {
  console.log(JSON.stringify(createMigrationDryRunReport(source, { blobRootPath }), null, 2));
} else if (args.includes("--write")) {
  const target = value("--v4");
  if (!target) {
    usage();
  }
  console.log(JSON.stringify(await createMigrationWriteReport({ sourceDatabaseFile: source, targetDatabaseFile: target, blobRootPath, overwrite: args.includes("--overwrite") }), null, 2));
} else {
  usage();
}
