import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildWithMateMemoryDiscoveryGenerationFileName,
  WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import {
  maintainMemoryV6LegacyDiscoveryArtifacts,
} from "../../src-electron/memory-v6-runtime.js";
import { publishRuntimeDiscoveryEntry } from "../../src/runtime-discovery/runtime-discovery-registry.js";

const NOW_MS = Date.parse("2026-08-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const CURRENT_GENERATION = "11111111-1111-4111-8111-111111111111";
const SELF_GENERATION = "22222222-2222-4222-8222-222222222222";
const REGISTRY_GENERATION = "33333333-3333-4333-8333-333333333333";
const EXTERNAL_GENERATION = "44444444-4444-4444-8444-444444444444";
const STALE_GENERATION = "55555555-5555-4555-8555-555555555555";
const REGISTRY_APPLICATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXTERNAL_API_SECRET = "external-test-api-secret";

async function createLegacyGenerationPair(
  runtimeDirectoryPath: string,
  runtimeGenerationId: string,
  baseUrl: string,
): Promise<string[]> {
  const filePaths: string[] = [];
  for (const adapter of ["cli", "mcp"] as const) {
    const filePath = path.join(
      runtimeDirectoryPath,
      buildWithMateMemoryDiscoveryGenerationFileName(adapter, runtimeGenerationId),
    );
    await writeFile(filePath, JSON.stringify({
      schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
      adapter,
      baseUrl,
      apiSecret: EXTERNAL_API_SECRET,
      adapterSecret: adapter + "-test-secret",
      runtimeInstanceId: runtimeGenerationId,
      publishedAt: "2026-08-28T00:00:00.000Z",
    }) + "\n", "utf8");
    filePaths.push(filePath);
  }
  return filePaths;
}

async function setGenerationAge(filePaths: string[], mtimeMs: number): Promise<void> {
  const timestamp = new Date(mtimeMs);
  await Promise.all(filePaths.map((filePath) => utimes(filePath, timestamp, timestamp)));
}

async function writeCurrentPointer(runtimeDirectoryPath: string, runtimeGenerationId: string): Promise<void> {
  await writeFile(
    path.join(runtimeDirectoryPath, WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME),
    JSON.stringify({
      schemaVersion: WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
      runtimeInstanceId: runtimeGenerationId,
    }) + "\n",
    "utf8",
  );
}

async function assertGenerationExists(runtimeDirectoryPath: string, runtimeGenerationId: string): Promise<void> {
  for (const adapter of ["cli", "mcp"] as const) {
    assert.equal((await stat(path.join(
      runtimeDirectoryPath,
      buildWithMateMemoryDiscoveryGenerationFileName(adapter, runtimeGenerationId),
    ))).isFile(), true);
  }
}

async function assertGenerationMissing(runtimeDirectoryPath: string, runtimeGenerationId: string): Promise<void> {
  for (const adapter of ["cli", "mcp"] as const) {
    await assert.rejects(() => stat(path.join(
      runtimeDirectoryPath,
      buildWithMateMemoryDiscoveryGenerationFileName(adapter, runtimeGenerationId),
    )), { code: "ENOENT" });
  }
}

// @test-value v1
// kind = "invariant"
// claim = "legacy回収は参照中またはidentity確認済みのgenerationを保護し、retention超過のstaleだけを削除する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "回収が稼働中または別ownerのgenerationを削除して外部操作経路を壊す"
// scope = "memory-legacy-discovery-retention"
// lifecycle = "permanent"
// distinction = "通常retentionで4種類の保護根拠と未参照staleを同時に観測する"
// @end-test-value
test("legacy generation回収は保護対象を残してretention超過のstaleだけを削除する", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "withmate-memory-legacy-retention-"));
  const runtimeDirectoryPath = path.join(root, "legacy");
  const registryDirectoryPath = path.join(root, "registry");
  await mkdir(runtimeDirectoryPath, { recursive: true });
  let registryPublication: Awaited<ReturnType<typeof publishRuntimeDiscoveryEntry>> | null = null;
  try {
    const generations = [
      [CURRENT_GENERATION, "http://127.0.0.1:4101"],
      [SELF_GENERATION, "http://127.0.0.1:4102"],
      [REGISTRY_GENERATION, "http://127.0.0.1:4103"],
      [EXTERNAL_GENERATION, "http://127.0.0.1:4104"],
      [STALE_GENERATION, "http://127.0.0.1:4105"],
    ] as const;
    for (const [generation, baseUrl] of generations) {
      const files = await createLegacyGenerationPair(runtimeDirectoryPath, generation, baseUrl);
      await setGenerationAge(files, NOW_MS - DAY_MS - 1);
    }
    await writeCurrentPointer(runtimeDirectoryPath, CURRENT_GENERATION);
    registryPublication = await publishRuntimeDiscoveryEntry({
      rootDirectoryPath: registryDirectoryPath,
      security: async () => undefined,
      clock: { now: () => new Date(NOW_MS) },
      identity: {
        applicationInstanceId: REGISTRY_APPLICATION,
        runtimeKind: "memory",
        runtimeGenerationId: REGISTRY_GENERATION,
      },
      buildChannel: "development",
      process: { pid: 1234, startedAt: new Date(NOW_MS).toISOString() },
      credentialDocuments: [{ adapterKind: "cli", document: { marker: "registry" } }],
      challenge: async () => false,
    });
    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const nonce = requestUrl.searchParams.get("nonce") ?? "";
      if (requestUrl.port !== "4104") {
        return new Response("{}", { status: 503 });
      }
      return Response.json({
        runtimeInstanceId: EXTERNAL_GENERATION,
        challenge: {
          nonce,
          hmacSha256: createHmac("sha256", EXTERNAL_API_SECRET).update(nonce, "utf8").digest("base64url"),
        },
      });
    };

    const result = await maintainMemoryV6LegacyDiscoveryArtifacts({
      runtimeDirectoryPath,
      registryDirectoryPath,
      currentRuntimeGenerationId: SELF_GENERATION,
      clock: { now: () => new Date(NOW_MS) },
      fetch: fetchImpl,
      maxGenerationFiles: 10,
      requiredCapacity: 2,
    });

    assert.deepEqual(result, {
      removedFileCount: 2,
      remainingFileCount: 8,
      capacityAvailable: true,
    });
    await assertGenerationExists(runtimeDirectoryPath, CURRENT_GENERATION);
    await assertGenerationExists(runtimeDirectoryPath, SELF_GENERATION);
    await assertGenerationExists(runtimeDirectoryPath, REGISTRY_GENERATION);
    await assertGenerationExists(runtimeDirectoryPath, EXTERNAL_GENERATION);
    await assertGenerationMissing(runtimeDirectoryPath, STALE_GENERATION);
  } finally {
    await registryPublication?.unpublish();
    await registryPublication?.cleanupGeneration();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "invariant"
// claim = "capacity回収は60秒grace前に削除せず、経過後にstaleだけを回収して予約容量を確保する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "若いgenerationを削除するか、期限超過後もartifact数が上限を超えて増え続ける"
// scope = "memory-legacy-discovery-capacity"
// lifecycle = "permanent"
// distinction = "capacity pressure時の60秒grace境界とfail-closed結果を観測する"
// @end-test-value
test("capacity pressureはgrace経過前に削除せず経過後に予約容量へ収束する", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "withmate-memory-legacy-capacity-"));
  const runtimeDirectoryPath = path.join(root, "legacy");
  const registryDirectoryPath = path.join(root, "registry");
  await mkdir(runtimeDirectoryPath, { recursive: true });
  try {
    const currentFiles = await createLegacyGenerationPair(
      runtimeDirectoryPath,
      CURRENT_GENERATION,
      "http://127.0.0.1:4201",
    );
    const staleFiles = await createLegacyGenerationPair(
      runtimeDirectoryPath,
      STALE_GENERATION,
      "http://127.0.0.1:4202",
    );
    await setGenerationAge(currentFiles, NOW_MS - DAY_MS);
    await setGenerationAge(staleFiles, NOW_MS - 30_000);
    await writeCurrentPointer(runtimeDirectoryPath, CURRENT_GENERATION);
    const fetchImpl: typeof fetch = async () => new Response("{}", { status: 503 });

    const beforeGrace = await maintainMemoryV6LegacyDiscoveryArtifacts({
      runtimeDirectoryPath,
      registryDirectoryPath,
      clock: { now: () => new Date(NOW_MS) },
      fetch: fetchImpl,
      maxGenerationFiles: 4,
      requiredCapacity: 2,
    });
    assert.deepEqual(beforeGrace, {
      removedFileCount: 0,
      remainingFileCount: 4,
      capacityAvailable: false,
    });
    await assertGenerationExists(runtimeDirectoryPath, STALE_GENERATION);

    const afterGrace = await maintainMemoryV6LegacyDiscoveryArtifacts({
      runtimeDirectoryPath,
      registryDirectoryPath,
      clock: { now: () => new Date(NOW_MS + 31_000) },
      fetch: fetchImpl,
      maxGenerationFiles: 4,
      requiredCapacity: 2,
    });
    assert.deepEqual(afterGrace, {
      removedFileCount: 2,
      remainingFileCount: 2,
      capacityAvailable: true,
    });
    await assertGenerationExists(runtimeDirectoryPath, CURRENT_GENERATION);
    await assertGenerationMissing(runtimeDirectoryPath, STALE_GENERATION);
    assert.equal((await readdir(runtimeDirectoryPath)).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
