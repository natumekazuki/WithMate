import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION,
  SESSION_RUNTIME_KIND,
  parseSessionRuntimeCredentialEnvelope,
} from "../../src/session-runtime-discovery.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  readRuntimeDiscoveryCredential,
} from "../../src/runtime-discovery/runtime-discovery-registry.js";
import { publishSessionRuntimeDiscovery } from "../../src-electron/session-external-runtime.js";
import {
  SessionRuntimeDiscoveryError,
  discoverSessionRuntime,
} from "../withmate-session-runtime-client.js";

const FIRST_APPLICATION_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_GENERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_APPLICATION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_GENERATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROCESS_STARTED_AT = "2026-09-05T00:00:00.000Z";
const security = async () => undefined;

// @test-value v1
// kind = "contract"
// claim = "Session runtime publicationはshared registryへsafe metadataだけを公開し、CLIとMCPのcredentialをgeneric envelopeで分離する"
// oracle = { type = "adr", ref = "ADR-023 Identity and registry ownership / Publish, lease, cleanup" }
// failure_mode = "registry entryへsecretが露出するか、CLIとMCPが同じadapter credentialへ結合される"
// scope = "session-runtime-discovery-publication"
// lifecycle = "permanent"
// @end-test-value
test("Session runtimeはshared registryへadapter別generic credential envelopeを公開する", async () => {
  const registryRootDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-session-registry-"));
  try {
    const publication = await publishSessionRuntimeDiscovery({
      applicationInstanceId: FIRST_APPLICATION_ID,
      runtimeGenerationId: FIRST_GENERATION_ID,
      buildChannel: "development",
      processStartedAt: PROCESS_STARTED_AT,
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      registryRootDirectoryPath,
      security,
    });
    const snapshot = await listRuntimeDiscoveryRegistryEntries(registryRootDirectoryPath);
    assert.equal(snapshot.records.length, 1);
    const record = snapshot.records[0]!;
    assert.deepEqual(
      {
        applicationInstanceId: record.entry.applicationInstanceId,
        runtimeKind: record.entry.runtimeKind,
        runtimeGenerationId: record.entry.runtimeGenerationId,
        buildChannel: record.entry.buildChannel,
      },
      {
        applicationInstanceId: FIRST_APPLICATION_ID,
        runtimeKind: SESSION_RUNTIME_KIND,
        runtimeGenerationId: FIRST_GENERATION_ID,
        buildChannel: "development",
      },
    );
    assert.equal(JSON.stringify(record.entry).includes("secret"), false);
    const cli = parseSessionRuntimeCredentialEnvelope(
      (await readRuntimeDiscoveryCredential(record, "cli"))!,
      record.entry,
      "cli",
    );
    const mcp = parseSessionRuntimeCredentialEnvelope(
      (await readRuntimeDiscoveryCredential(record, "mcp"))!,
      record.entry,
      "mcp",
    );
    assert.equal(cli?.credential.schemaVersion, SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION);
    assert.equal(cli?.credential.adapterSecret, "cli-secret");
    assert.equal(mcp?.credential.adapterSecret, "mcp-secret");
    assert.notEqual(cli?.credential.adapterSecret, mcp?.credential.adapterSecret);
    await publication.unpublish();
    await publication.cleanupGeneration();
  } finally {
    await rm(registryRootDirectoryPath, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "regression"
// claim = "複数Session runtimeはunbound discoveryで曖昧となり、後発runtime終了後は先発の生存runtimeを選択できる"
// oracle = { type = "adr", ref = "ADR-023 Selection and binding / Consequences" }
// failure_mode = "last-writer pointerまたは非owner cleanupにより、生存中の先発runtimeが選択不能になる"
// scope = "session-runtime-discovery-selection-and-owner-cleanup"
// lifecycle = "permanent"
// distinction = "二つのapplication instanceを公開し、逆順終了後の再選択まで観測する"
// @end-test-value
test("Session runtimeの逆順終了後も生存instanceをshared registryから再選択する", async () => {
  const registryRootDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-session-owner-"));
  const common = {
    buildChannel: "development" as const,
    processStartedAt: PROCESS_STARTED_AT,
    apiSecret: "api-secret",
    cliSecret: "cli-secret",
    mcpSecret: "mcp-secret",
    registryRootDirectoryPath,
    security,
  };
  try {
    const first = await publishSessionRuntimeDiscovery({
      ...common,
      applicationInstanceId: FIRST_APPLICATION_ID,
      runtimeGenerationId: FIRST_GENERATION_ID,
      baseUrl: "http://127.0.0.1:10001",
    });
    const second = await publishSessionRuntimeDiscovery({
      ...common,
      applicationInstanceId: SECOND_APPLICATION_ID,
      runtimeGenerationId: SECOND_GENERATION_ID,
      baseUrl: "http://127.0.0.1:10002",
    });

    await assert.rejects(
      () => discoverSessionRuntime({ env: {}, registryRootDirectoryPath }),
      (error) => error instanceof SessionRuntimeDiscoveryError
        && error.code === "runtime_ambiguous",
    );

    await second.unpublish();
    await second.cleanupGeneration();
    const selected = await discoverSessionRuntime({ env: {}, registryRootDirectoryPath });
    assert.equal(selected?.applicationInstanceId, FIRST_APPLICATION_ID);
    assert.equal(selected?.runtimeGenerationId, FIRST_GENERATION_ID);

    await first.unpublish();
    await first.cleanupGeneration();
  } finally {
    await rm(registryRootDirectoryPath, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "security"
// claim = "binding-required discoveryはapplication instanceとSession generationの完全一致だけを選択する"
// oracle = { type = "adr", ref = "ADR-023 Selection and binding" }
// failure_mode = "provider-bound clientが指定generation不一致時に別generationまたはunbound runtimeへfallbackする"
// scope = "session-runtime-bound-selection"
// lifecycle = "permanent"
// distinction = "同一applicationの存在下でstale generation selectorを指定しgeneration_changedを観測する"
// @end-test-value
test("provider-bound Session discoveryは指定generation不一致でfallbackしない", async () => {
  const registryRootDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-session-bound-"));
  try {
    const publication = await publishSessionRuntimeDiscovery({
      applicationInstanceId: FIRST_APPLICATION_ID,
      runtimeGenerationId: FIRST_GENERATION_ID,
      buildChannel: "development",
      processStartedAt: PROCESS_STARTED_AT,
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      registryRootDirectoryPath,
      security,
    });
    await assert.rejects(
      () => discoverSessionRuntime({
        env: {
          WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
          WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-reference",
          WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID: FIRST_APPLICATION_ID,
          WITHMATE_SESSION_RUNTIME_GENERATION_ID: SECOND_GENERATION_ID,
        },
        registryRootDirectoryPath,
      }),
      (error) => error instanceof SessionRuntimeDiscoveryError
        && error.code === "runtime_generation_changed",
    );
    await publication.unpublish();
    await publication.cleanupGeneration();
  } finally {
    await rm(registryRootDirectoryPath, { recursive: true, force: true });
  }
});
