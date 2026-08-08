import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunInteractionResponseService,
  type ApplicationRunInteractionResponseOwnerInput,
  type ApplicationRunInteractionResponseOwnerPort,
  type ApplicationRunInteractionResponseReplayPort,
} from "../src/main/application-run-interaction-response-service.js";
import { CODEX_PROVIDER_DEFINITION_VERSION, codexProviderDefinition } from "../src/main/providers/codex/index.js";
import { ProviderDefinitionRegistry } from "../src/main/providers/provider-definition.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";
import type { RunInteractionResponseResult } from "../src/shared/repository-write-model.js";

const workspace = (() => {
  const resolved = resolveWorkspaceIdentity(process.cwd());
  if (resolved === undefined) throw new TypeError("Test workspace identity is unavailable.");
  return resolved;
})();

const request = {
  context: { authorization: { principal: "test" } },
  sessionId: "session-1",
  runId: "run-1",
  idempotencyKey: "10000000-0000-4000-8000-000000000001",
  response: {
    interactionId: "interaction-1",
    kind: "codex.command_approval",
    payload: { decision: "accept" },
  },
} as const;

test("same-key durable replay returns the current public certainty without touching the live owner", async () => {
  let ownerCalls = 0;
  const replayValue = interactionResult({
    effectCertainty: "ambiguous",
    writeAttemptedAt: 12,
    settledAt: 13,
    resolutionCode: "transport_unknown",
  });
  const service = responseService({
    replay: {
      async probe(input) {
        assert.equal(input.canonicalResponseJson, JSON.stringify(request.response));
        return { kind: "replay", value: replayValue };
      },
    },
    owner: {
      async respond() {
        ownerCalls += 1;
        throw new Error("owner must not be called");
      },
    },
  });

  const response = await service.respondInteraction(request);
  assert.equal(response.overallStatus, "success");
  assert.equal(ownerCalls, 0);
  if (response.overallStatus !== "success") return;
  assert.deepEqual(response.value, {
    sessionId: "session-1",
    runId: "run-1",
    interactionId: "interaction-1",
    admittedAt: 10,
    effectCertainty: "ambiguous",
    writeAttemptedAt: 12,
    settledAt: 13,
    resolutionCode: "transport_unknown",
  });
  assert.equal(JSON.stringify(response).includes("responseRefId"), false);
  assert.equal(JSON.stringify(response).includes("providerId"), false);
  assert.equal(JSON.stringify(response).includes("semanticAction"), false);
});

test("fresh response uses the dynamically supplied Provider canonicalizer before live owner admission", async () => {
  let shapeCanonicalizations = 0;
  const providers = new ProviderDefinitionRegistry([
    {
      ...codexProviderDefinition,
      canonicalizeInteractionResponseShape(value) {
        shapeCanonicalizations += 1;
        return codexProviderDefinition.canonicalizeInteractionResponseShape(value);
      },
    },
  ]);
  let ownerInput: ApplicationRunInteractionResponseOwnerInput | undefined;
  const service = responseService({
    providers,
    owner: {
      async respond(input) {
        ownerInput = input;
        return { ok: true, replayed: false, value: interactionResult(resolvedCertainty()) };
      },
    },
  });

  const response = await service.respondInteraction(request);
  assert.equal(response.overallStatus, "success");
  assert.equal(shapeCanonicalizations, 1);
  assert.equal(ownerInput?.providerId, "codex");
  assert.equal(ownerInput?.definitionVersion, CODEX_PROVIDER_DEFINITION_VERSION);
  assert.equal(ownerInput?.canonicalResponseJson, JSON.stringify(request.response));
});

test("Application projection preserves valid not-sent certainty tuples and rejects invalid cross-products", async () => {
  const valid = [
    {
      effectCertainty: "not_sent",
      writeAttemptedAt: null,
      settledAt: 12,
      resolutionCode: "owner_lost_before_write",
    },
    { effectCertainty: "not_sent", writeAttemptedAt: null, settledAt: 12, resolutionCode: "adapter_rejected" },
    { effectCertainty: "not_sent", writeAttemptedAt: 11, settledAt: 12, resolutionCode: "transport_not_sent" },
    { effectCertainty: "not_sent", writeAttemptedAt: 11, settledAt: 12, resolutionCode: "adapter_rejected" },
  ] as const;
  for (const certainty of valid) {
    const service = responseService({
      owner: {
        async respond() {
          return { ok: true, replayed: false, value: interactionResult(certainty) };
        },
      },
    });
    const response = await service.respondInteraction(request);
    assert.equal(
      response.overallStatus,
      "success",
      `${String(certainty.writeAttemptedAt)}:${certainty.resolutionCode}`,
    );
  }

  for (const certainty of [
    { effectCertainty: "not_sent", writeAttemptedAt: null, settledAt: 12, resolutionCode: "transport_not_sent" },
    { effectCertainty: "not_sent", writeAttemptedAt: 11, settledAt: 12, resolutionCode: "owner_lost_before_write" },
  ] as const) {
    const invalid = {
      ...interactionResult(resolvedCertainty()),
      ...certainty,
    } as unknown as RunInteractionResponseResult;
    const service = responseService({
      owner: {
        async respond() {
          return { ok: true, replayed: false, value: invalid };
        },
      },
    });
    await assert.rejects(
      service.respondInteraction(request),
      /Interaction response result is invalid/u,
      `${String(certainty.writeAttemptedAt)}:${certainty.resolutionCode}`,
    );
  }
});

test("Application projection rejects impossible certainty timestamp orderings", async () => {
  const invalidValues = [
    {
      effectCertainty: "write_attempted",
      writeAttemptedAt: 9,
      settledAt: null,
      resolutionCode: null,
    },
    {
      effectCertainty: "resolved",
      writeAttemptedAt: 11,
      settledAt: 9,
      resolutionCode: "provider_resolved",
    },
    {
      effectCertainty: "ambiguous",
      writeAttemptedAt: 12,
      settledAt: 11,
      resolutionCode: "transport_unknown",
    },
    {
      effectCertainty: "not_sent",
      writeAttemptedAt: null,
      settledAt: 9,
      resolutionCode: "owner_lost_before_write",
    },
    {
      effectCertainty: "not_sent",
      writeAttemptedAt: 9,
      settledAt: 12,
      resolutionCode: "transport_not_sent",
    },
  ] as const;

  for (const certainty of invalidValues) {
    const invalid = {
      ...interactionResult(resolvedCertainty()),
      ...certainty,
    } as unknown as RunInteractionResponseResult;
    const service = responseService({
      owner: {
        async respond() {
          return { ok: true, replayed: false, value: invalid };
        },
      },
    });
    await assert.rejects(
      service.respondInteraction(request),
      /Interaction response result is invalid/u,
      certainty.effectCertainty,
    );
  }
});

test("strict request decoding rejects proxy, accessor, sparse, and unknown-field inputs before replay or owner", async () => {
  let downstreamCalls = 0;
  const service = responseService({
    replay: {
      async probe() {
        downstreamCalls += 1;
        return { kind: "absent" };
      },
    },
    owner: {
      async respond() {
        downstreamCalls += 1;
        return { ok: true, replayed: false, value: interactionResult(resolvedCertainty()) };
      },
    },
  });
  let getterReads = 0;
  const accessor = { ...request, response: { ...request.response } } as Record<string, unknown>;
  Object.defineProperty(accessor.response as object, "payload", {
    enumerable: true,
    get() {
      getterReads += 1;
      return { decision: "accept" };
    },
  });
  const sparse = { ...request, response: { ...request.response, payload: { answers: new Array(1) } } };
  const invalid = [new Proxy({ ...request }, {}), accessor, sparse, { ...request, unexpected: true }];
  for (const value of invalid) {
    const response = await service.respondInteraction(value as never);
    assert.equal(response.overallStatus, "failure");
    assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
  }
  assert.equal(getterReads, 0);
  assert.equal(downstreamCalls, 0);
});

test("abort before owner start has no effect, while abort after owner start stops only the caller wait", async () => {
  let ownerCalls = 0;
  let finishOwner!: () => void;
  const ownerStarted = new Promise<void>((resolve) => {
    finishOwner = resolve;
  });
  let resolveOwner!: (value: ReturnType<typeof interactionResult>) => void;
  const ownerSettlement = new Promise<ReturnType<typeof interactionResult>>((resolve) => {
    resolveOwner = resolve;
  });
  const service = responseService({
    owner: {
      async respond() {
        ownerCalls += 1;
        finishOwner();
        return { ok: true, replayed: false, value: await ownerSettlement };
      },
    },
  });

  const before = new AbortController();
  before.abort();
  const rejected = await service.respondInteraction(request, { signal: before.signal });
  assert.equal(rejected.overallStatus, "failure");
  assert.equal(ownerCalls, 0);

  const after = new AbortController();
  const pending = service.respondInteraction(request, { signal: after.signal });
  await ownerStarted;
  after.abort();
  const interrupted = await pending;
  assert.equal(interrupted.overallStatus, "failure");
  assert.equal(ownerCalls, 1);
  resolveOwner(interactionResult(resolvedCertainty()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ownerCalls, 1);
});

function responseService(options: {
  owner?: ApplicationRunInteractionResponseOwnerPort;
  replay?: ApplicationRunInteractionResponseReplayPort;
  providers?: ProviderDefinitionRegistry;
}) {
  return new ApplicationRunInteractionResponseService({
    reads: {
      async readSession() {
        return { session: { id: "session-1", workspaceKey: workspace.workspaceKey } } as never;
      },
      async readRun() {
        return {
          sessionId: "session-1",
          workspaceKey: workspace.workspaceKey,
          run: {
            id: "run-1",
            sessionId: "session-1",
            executionSnapshotState: "inline",
            executionSnapshotByteLength: 1,
            executionSnapshot: executionSnapshot(),
          },
        } as never;
      },
      async readSnapshotChunk() {
        throw new Error("inline snapshot expected");
      },
    },
    access: {
      async authorize() {
        return { allowed: true };
      },
    },
    snapshotAuthorization(value) {
      const candidate = value as { principal?: unknown };
      if (candidate.principal !== "test") throw new TypeError("authorization invalid");
      return { principal: "test" } as const;
    },
    owner:
      options.owner ??
      ({
        async respond() {
          return { ok: true, replayed: false, value: interactionResult(resolvedCertainty()) };
        },
      } satisfies ApplicationRunInteractionResponseOwnerPort),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
  });
}

function executionSnapshot() {
  return {
    providerId: "codex",
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    modelSelection: "explicit",
    settings: {
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      approvalPolicy: "on-request",
      sandbox: { mode: "workspace-write", networkAccess: false },
    },
    workspace: { key: workspace.workspaceKey, path: workspace.workspacePath, allowedAdditionalDirectories: [] },
    character: null,
  };
}

function interactionResult(
  certainty:
    | ReturnType<typeof resolvedCertainty>
    | Readonly<{
        effectCertainty: "ambiguous";
        writeAttemptedAt: number;
        settledAt: number;
        resolutionCode: "transport_unknown";
      }>
    | Readonly<{
        effectCertainty: "not_sent";
        writeAttemptedAt: null;
        settledAt: number;
        resolutionCode: "owner_lost_before_write" | "adapter_rejected";
      }>
    | Readonly<{
        effectCertainty: "not_sent";
        writeAttemptedAt: number;
        settledAt: number;
        resolutionCode: "transport_not_sent" | "adapter_rejected";
      }>,
): RunInteractionResponseResult {
  return {
    responseRefId: "response-ref-1",
    sessionId: "session-1",
    runId: "run-1",
    interactionId: "interaction-1",
    providerId: "codex",
    definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
    interactionKind: "codex.command_approval",
    semanticAction: "accept",
    admittedAt: 10,
    ...certainty,
  };
}

function resolvedCertainty() {
  return {
    effectCertainty: "resolved",
    writeAttemptedAt: 11,
    settledAt: 12,
    resolutionCode: "provider_resolved",
  } as const;
}
