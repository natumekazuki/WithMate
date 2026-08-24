import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import {
  GlossaryApplicationService,
  projectGlossaryCheckoutAuthority,
} from "../../src-electron/glossary-application-service.js";
import { GlossaryRuntimeService } from "../../src-electron/glossary-runtime-service.js";
import { createMemoryV6HttpServer } from "../../src-electron/memory-v6-http-server.js";
import type { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import {
  GLOSSARY_RUNTIME_OPERATION_PATHS,
  getGlossaryAgentRuntimeOperations,
} from "../../src/glossary-operation-schema.js";
import { GLOSSARY_RUNTIME_SCHEMA_VERSION } from "../../src/glossary-contract.js";
import { callWithMateMemoryRuntime } from "../withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../../src/memory-v6/memory-runtime-exchange.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-runtime-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", root], { windowsHide: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRuntime(root: string, options: { proactiveLimit?: number | null } = {}) {
  const applicationService = new GlossaryApplicationService();
  const registry = new AgentRuntimeBindingRegistry();
  const actor = {
    id: "session-a",
    providerId: "codex",
    characterId: "character-a",
    workspacePath: root,
  };
  const target = await applicationService.resolvePrimaryCheckout(root);
  const binding = registry.issueOrReuse({
    actorSessionId: actor.id,
    providerId: actor.providerId,
    authoritySnapshot: { glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(target) },
    operationGrants: getGlossaryAgentRuntimeOperations(),
  });
  const runtime = new GlossaryRuntimeService({
    applicationService,
    bindingRegistry: registry,
    resolveActorSession: (sessionId) => sessionId === actor.id ? actor : null,
    getProactiveCreateLimit: () => options.proactiveLimit,
  });
  const call = (operation: keyof typeof GLOSSARY_RUNTIME_OPERATION_PATHS, body: unknown, reference = binding.bindingReference) =>
    runtime.route({
      method: "POST",
      path: GLOSSARY_RUNTIME_OPERATION_PATHS[operation],
      body,
      transport: "mcp",
      bindingReference: reference,
    });
  return { actor, applicationService, binding, call, registry, runtime, target };
}

describe("GLOSSARY-CHECKOUT-AUTHORITY runtime service", () => {
  it("list-targetsはbinding発行時のprimary checkout 1件だけをopaque IDで返す", async () => {
    const root = await createRepository();
    const { call } = await createRuntime(root);

    const response = await call("list_targets", { schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION });
    assert.equal(response?.status, 200);
    const value = response?.value as {
      schemaVersion: string;
      targets: Array<{ checkoutId: string; isPrimary: boolean; pathLabel: string; branch: string }>;
    };
    assert.equal(value.schemaVersion, GLOSSARY_RUNTIME_SCHEMA_VERSION);
    assert.equal(value.targets.length, 1);
    assert.equal(value.targets[0].isPrimary, true);
    assert.equal(value.targets[0].pathLabel, path.basename(root));
    assert.equal(value.targets[0].branch, "main");
    assert.ok(value.targets[0].checkoutId);
  });

  it("primary selectorと同generationのcheckoutIdだけを同じtargetへ解決する", async () => {
    const root = await createRepository();
    const { call } = await createRuntime(root);
    const listed = await call("list_targets", { schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION });
    const checkoutId = (listed?.value as { targets: Array<{ checkoutId: string }> }).targets[0].checkoutId;

    const primary = await call("list", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" },
    });
    const opaque = await call("list", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "checkout", checkoutId },
    });
    const unknown = await call("list", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "checkout", checkoutId: "another-session-target" },
    });

    assert.deepEqual(opaque?.value, primary?.value);
    assert.equal(unknown?.status, 404);
    assert.equal((unknown?.value as { code: string }).code, "GLOSSARY_CHECKOUT_NOT_FOUND");
  });

  it("binding欠落、失効generation、actor workspace差し替えをside effect前に拒否する", async () => {
    const firstRoot = await createRepository();
    const secondRoot = await createRepository();
    const { actor, binding, call, registry } = await createRuntime(firstRoot);
    const body = {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" },
      mode: "explicit",
      entry: { term: "Runtime", definition: "authority" },
    };

    const missing = await call("create", body, "");
    assert.equal(missing?.status, 401);
    assert.equal((missing?.value as { code: string }).code, "GLOSSARY_SESSION_BINDING_REQUIRED");

    actor.workspacePath = secondRoot;
    const replaced = await call("create", body);
    assert.equal(replaced?.status, 401);
    assert.equal((replaced?.value as { code: string }).code, "GLOSSARY_SESSION_BINDING_INVALID");
    await assert.rejects(() => readFile(path.join(firstRoot, ".withmate", "glossary.yaml"), "utf8"));
    await assert.rejects(() => readFile(path.join(secondRoot, ".withmate", "glossary.yaml"), "utf8"));

    registry.issueOrReuse({
      actorSessionId: actor.id,
      providerId: actor.providerId,
      authoritySnapshot: { generation: "replacement" },
      operationGrants: getGlossaryAgentRuntimeOperations(),
    });
    const stale = await call("list_targets", { schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION }, binding.bindingReference);
    assert.equal(stale?.status, 401);
    assert.equal((stale?.value as { code: string }).code, "GLOSSARY_SESSION_BINDING_INVALID");
  });
});

describe("Glossary runtime mutation policy", () => {
  it("explicit createをapplication serviceへ委譲し、update/deleteの明示依頼markerをschemaで要求する", async () => {
    const root = await createRepository();
    const { call } = await createRuntime(root);
    const created = await call("create", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" },
      mode: "explicit",
      entry: { term: "Runtime", aliases: ["RT"], definition: "plain text" },
    });
    assert.equal(created?.status, 200);
    assert.equal((created?.value as { outcome: string }).outcome, "applied");

    const rejected = await call("update", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" },
      expectedRevision: (created?.value as { revision: string }).revision,
      targetTerm: "Runtime",
      entry: { term: "Runtime", definition: "changed" },
    });
    assert.equal(rejected?.status, 400);
    assert.equal((rejected?.value as { code: string }).code, "GLOSSARY_INVALID_REQUEST");
  });

  it("proactive createはSettings値が欠落・不正ならfallbackせず拒否する", async () => {
    const root = await createRepository();
    const { actor, call, runtime } = await createRuntime(root, { proactiveLimit: null });
    const turn = runtime.beginProviderTurn(actor.id, actor.providerId);
    const response = await call("create", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" },
      mode: "proactive",
      entry: { term: "Runtime", definition: "plain text" },
    });
    assert.equal(response?.status, 400);
    assert.equal((response?.value as { code: string }).code, "GLOSSARY_INVALID_REQUEST");
    await assert.rejects(() => readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"));
    runtime.endProviderTurn(turn);
  });

  it("同じturnでは完全同一retryだけを許し、複数proactive callでSettings上限を迂回させない", async () => {
    const root = await createRepository();
    const { actor, call, runtime } = await createRuntime(root, { proactiveLimit: 2 });
    const turn = runtime.beginProviderTurn(actor.id, actor.providerId);
    const firstBody = {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" as const },
      mode: "proactive" as const,
      entry: { term: "Runtime", definition: "plain text" },
    };

    const first = await call("create", firstBody);
    const retry = await call("create", firstBody);
    const second = await call("create", {
      ...firstBody,
      entry: { term: "Projection", definition: "second call" },
    });

    assert.equal((first?.value as { outcome: string }).outcome, "applied");
    assert.equal((retry?.value as { outcome: string }).outcome, "converged");
    assert.equal(second?.status, 400);
    assert.equal((second?.value as { code: string }).code, "GLOSSARY_LIMIT_EXCEEDED");
    const stored = await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8");
    assert.match(stored, /Runtime/);
    assert.doesNotMatch(stored, /Projection/);

    runtime.endProviderTurn(turn);
    const nextTurn = runtime.beginProviderTurn(actor.id, actor.providerId);
    const next = await call("create", {
      ...firstBody,
      entry: { term: "Projection", definition: "next turn" },
    });
    assert.equal((next?.value as { outcome: string }).outcome, "applied");
    runtime.endProviderTurn(nextTurn);

    const rejectedTurn = runtime.beginProviderTurn(actor.id, actor.providerId);
    const oversizedFirst = await call("create_batch", {
      schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
      selector: { kind: "primary" },
      mode: "proactive",
      entries: [
        { term: "One", definition: "one" },
        { term: "Two", definition: "two" },
        { term: "Three", definition: "three" },
      ],
    });
    const smallerSecond = await call("create", {
      ...firstBody,
      entry: { term: "Smaller", definition: "must remain rejected" },
    });
    assert.equal((oversizedFirst?.value as { code: string }).code, "GLOSSARY_LIMIT_EXCEEDED");
    assert.equal((smallerSecond?.value as { code: string }).code, "GLOSSARY_LIMIT_EXCEEDED");
    runtime.endProviderTurn(rejectedTurn);
  });
});

describe("Glossary authenticated runtime exchange", () => {
  it("MCPとCLI adapterを同じschema・authority・application serviceへdispatchし、direct HTTPは公開しない", async () => {
    const root = await createRepository();
    const { actor, binding, registry, runtime } = await createRuntime(root);
    const server = createMemoryV6HttpServer({
      service: {} as MemoryV6Service,
      apiSecret: "api-secret",
      operatorApiSecret: "operator-secret",
      mcpApiSecret: "mcp-secret",
      runtimeInstanceId: "runtime-a",
      agentRuntimeBindingRegistry: registry,
      resolveActorSession: (sessionId) => sessionId === actor.id ? actor : null,
      routeAgentRuntimeExtension: (request) => runtime.route(request),
    });
    await server.start();
    try {
      const address = server.address();
      assert.ok(address);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const operation = {
        method: "POST" as const,
        path: GLOSSARY_RUNTIME_OPERATION_PATHS.list,
        body: {
          schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
          selector: { kind: "primary" },
        },
      };
      const api = { baseUrl, apiSecret: "api-secret", runtimeInstanceId: "runtime-a" };
      const mcp = await callWithMateMemoryRuntime(
        { api, credential: { adapter: "mcp", adapterSecret: "mcp-secret" } },
        operation,
        {
          signal: new AbortController().signal,
          bindingReference: binding.bindingReference,
          exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        },
      );
      const cli = await callWithMateMemoryRuntime(
        { api, credential: { adapter: "cli", adapterSecret: "operator-secret" } },
        operation,
        {
          signal: new AbortController().signal,
          bindingReference: binding.bindingReference,
          exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        },
      );
      assert.equal(mcp.status, 200);
      assert.deepEqual(cli.value, mcp.value);

      const genericSmallExchange = await callWithMateMemoryRuntime(
        { api, credential: { adapter: "mcp", adapterSecret: "mcp-secret" } },
        operation,
        { signal: new AbortController().signal, bindingReference: binding.bindingReference },
      );
      assert.equal(genericSmallExchange.status, 404);

      const direct = await fetch(`${baseUrl}${GLOSSARY_RUNTIME_OPERATION_PATHS.list}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-withmate-memory-api-secret": "api-secret",
        },
        body: JSON.stringify(operation.body),
      });
      assert.equal(direct.status, 404);

      const largeBatchOperation = {
        method: "POST" as const,
        path: GLOSSARY_RUNTIME_OPERATION_PATHS.create_batch,
        body: {
          schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
          selector: { kind: "primary" as const },
          mode: "explicit" as const,
          entries: Array.from({ length: 6 }, (_, index) => ({
            term: `Large ${index}`,
            definition: `${index}${"x".repeat(45_000)}`,
          })),
        },
      };
      const genericExchange = await callWithMateMemoryRuntime(
        { api, credential: { adapter: "mcp", adapterSecret: "mcp-secret" } },
        largeBatchOperation,
        { signal: new AbortController().signal, bindingReference: binding.bindingReference },
      );
      assert.equal(genericExchange.status, 413);

      const extensionExchange = await callWithMateMemoryRuntime(
        { api, credential: { adapter: "mcp", adapterSecret: "mcp-secret" } },
        largeBatchOperation,
        {
          signal: new AbortController().signal,
          bindingReference: binding.bindingReference,
          exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        },
      );
      assert.equal(extensionExchange.status, 200);
      assert.equal((extensionExchange.value as { outcome: string }).outcome, "applied");
      const stored = await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8");
      assert.match(stored, /Large 5/);
    } finally {
      await server.stop();
    }
  });
});
