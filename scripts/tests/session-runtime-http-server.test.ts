import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import {
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
} from "../../src/session-runtime-exchange.js";
import { createSessionRuntimeHttpServer } from "../../src-electron/session-runtime-http-server.js";

const secrets = {
  apiSecret: "api-secret",
  cliSecret: "cli-secret",
  mcpSecret: "mcp-secret",
  runtimeInstanceId: "runtime-1",
};

test("Session runtime authenticates identity and adapter before invoking handler", async () => {
  const calls: string[] = [];
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation, _input, adapter) => {
      calls.push(`${adapter}:${operation}`);
      return createSessionRuntimeResult(operation, { ok: true });
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    const unauthorized = await post(address.port, exchangePayload("cli", body, { apiSecret: "wrong" }));
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(calls, []);

    const authorized = await post(address.port, exchangePayload("cli", body));
    assert.equal(authorized.status, 200);
    assert.deepEqual(calls, ["cli:turn.get"]);

    const wrongAdapter = await post(address.port, exchangePayload("mcp", body, { adapterSecret: secrets.cliSecret }));
    assert.equal(wrongAdapter.status, 401);
    assert.deepEqual(calls, ["cli:turn.get"]);
  } finally {
    await server.stop();
  }
});

test("Session runtime rejects a declared body over 8 MiB before handler invocation", async () => {
  let invoked = false;
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation) => {
      invoked = true;
      return createSessionRuntimeResult(operation, {});
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const response = await post(address.port, exchangePayload("cli", "{}"), {
      "Content-Length": String(SESSION_RUNTIME_MAX_BODY_BYTES + 1),
    }, false);
    assert.equal(response.status, 413);
    assert.equal(invoked, false);
  } finally {
    await server.stop();
  }
});

test("Session runtime status proves the discovered runtime identity", async () => {
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation) => createSessionRuntimeResult(operation, {}),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/status?nonce=status-nonce`);
    assert.equal(response.status, 200);
    const result = await response.json() as { runtimeInstanceId: string; challenge: { hmacSha256: string } };
    assert.equal(result.runtimeInstanceId, secrets.runtimeInstanceId);
    assert.equal(
      result.challenge.hmacSha256,
      createSessionRuntimeChallenge(secrets.apiSecret, secrets.runtimeInstanceId, "status-nonce"),
    );
  } finally {
    await server.stop();
  }
});

test("RL-01: Session runtime replaces an oversized success response with a stable error", async () => {
  const server = createSessionRuntimeHttpServer({
    ...secrets,
    handle: async (operation) => createSessionRuntimeResult(operation, {
      assistantText: "a".repeat(SESSION_RUNTIME_MAX_RESPONSE_BYTES),
    }),
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const body = JSON.stringify({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.get",
      input: { sessionId: "session-1", executionId: "execution-1" },
    });
    const response = await post(address.port, exchangePayload("cli", body));
    assert.equal(response.status, 413);
    const error = JSON.parse(response.body).error;
    assert.equal(error.code, "CONTENT_TOO_LARGE");
    assert.equal(error.effect, "not_applied");
    assert.ok(Buffer.byteLength(response.body) <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
  } finally {
    await server.stop();
  }
});

function exchangePayload(
  adapter: "cli" | "mcp",
  envelopeBody: string,
  overrides: { apiSecret?: string; adapterSecret?: string } = {},
): string {
  return JSON.stringify({
    schemaVersion: SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
    apiSecret: overrides.apiSecret ?? secrets.apiSecret,
    adapter,
    adapterSecret: overrides.adapterSecret ?? (adapter === "cli" ? secrets.cliSecret : secrets.mcpSecret),
    envelope: JSON.parse(envelopeBody),
  });
}

function challengeHeaders(nonce: string): Record<string, string> {
  return {
    [SESSION_RUNTIME_INSTANCE_HEADER]: secrets.runtimeInstanceId,
    [SESSION_RUNTIME_NONCE_HEADER]: nonce,
  };
}

function post(
  port: number,
  payload: string,
  headers: Record<string, string> = {},
  writeBody = true,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: SESSION_RUNTIME_OPERATION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...challengeHeaders("nonce-1"),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        request.destroy();
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", reject);
    request.once("information", (information) => {
      if (information.statusCode === 103) request.end(writeBody ? payload : undefined);
    });
    request.flushHeaders();
  });
}
