import { createMigrationDryRunReport, createMigrationWriteReport } from "../../src-electron/storage/migrations/migrate-database-v2-to-v3.js";

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/migrations/migrate-database-v2-to-v3.ts --dry-run --v2 <path-to-withmate-v2.db>\n"
      + "       npx tsx scripts/migrations/migrate-database-v2-to-v3.ts --write --v2 <path-to-withmate-v2.db> --v3 <path-to-withmate-v3.db> --blob-root <path-to-blobs> [--overwrite]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const value = (names: string[]) => {
  const index = args.findIndex((arg) => names.includes(arg));
  return index >= 0 ? args[index + 1] : undefined;
};
const source = value(["--v2", "--source", "--input"]);
const target = value(["--v3", "--target"]);
const blobRoot = value(["--blob-root", "--blobs"]);
const overwrite = args.includes("--overwrite");
if (args.includes("--dry-run") && source) {
  console.log(JSON.stringify(createMigrationDryRunReport(source), null, 2));
} else if (args.includes("--write") && source && target && blobRoot) {
  console.log(JSON.stringify(await createMigrationWriteReport({ sourceDatabaseFile: source, targetDatabaseFile: target, blobRootPath: blobRoot, overwrite }), null, 2));
} else {
  usage();
}
