import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexJsonlDecoder } from "../src/main/providers/codex/jsonl-decoder.js";
import { CODEX_TRANSPORT_LIMITS } from "../src/main/providers/codex/transport-limits.js";
import { CodexWireProtocolError, type CodexWireEnvelope } from "../src/main/providers/codex/wire-envelope.js";

const encoder = new TextEncoder();
const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-fixture.mjs", import.meta.url));

test("JSONL decoder preserves UTF-8 split boundaries, multiple lines, and CRLF", () => {
  const decoder = new CodexJsonlDecoder();
  const bytes = encoder.encode('{"id":1,"result":{"text":"境界"}}\r\n{"method":"future/event","params":{"ok":true}}\n');
  const splitInsideCharacter = bytes.indexOf(0xe7) + 1;
  const envelopes: CodexWireEnvelope[] = [];

  decoder.push(bytes.subarray(0, splitInsideCharacter), (envelope) => envelopes.push(envelope));
  assert.equal(envelopes.length, 0);
  decoder.push(bytes.subarray(splitInsideCharacter), (envelope) => envelopes.push(envelope));
  assert.deepEqual(envelopes, [
    { kind: "response", id: 1, result: { text: "境界" } },
    { kind: "notification", method: "future/event", params: { ok: true } },
  ]);
  decoder.finish();
});

test("JSONL decoder accepts omitted jsonrpc and exact jsonrpc 2.0 envelopes", () => {
  const envelopes = decode(
    [
      '{"jsonrpc":"2.0","id":"request-1","result":null}',
      '{"id":2,"error":{"code":-32600,"message":"invalid","data":{"reason":"test"}}}',
      '{"jsonrpc":"2.0","id":"server-1","method":"future/request","params":{"value":1},"trace":null}',
      '{"method":"future/notification"}',
    ].join("\n") + "\n",
  );

  assert.deepEqual(envelopes, [
    { kind: "response", id: "request-1", result: null, jsonrpc: "2.0" },
    {
      kind: "errorResponse",
      id: 2,
      error: { code: -32600, message: "invalid", data: { reason: "test" } },
    },
    {
      kind: "serverRequest",
      id: "server-1",
      method: "future/request",
      params: { value: 1 },
      trace: null,
      jsonrpc: "2.0",
    },
    { kind: "notification", method: "future/notification" },
  ]);
});

test("JSONL decoder rejects malformed JSON without exposing the raw line", () => {
  const decoder = new CodexJsonlDecoder();
  const message = caughtMessage(() => decoder.push(encoder.encode('{"token":"secret"\n'), () => undefined));
  assert.match(message, /malformed JSON/u);
  assert.doesNotMatch(message, /secret/u);
});

test("JSONL decoder rejects invalid UTF-8, empty lines, and partial EOF lines", () => {
  assertProtocolError(
    () => new CodexJsonlDecoder().push(Uint8Array.from([0xc3, 0x28, 0x0a]), () => undefined),
    "invalid_utf8",
  );
  assertProtocolError(() => new CodexJsonlDecoder().push(encoder.encode("\r\n"), () => undefined), "empty_line");

  const invalidEof = new CodexJsonlDecoder();
  invalidEof.push(Uint8Array.from([0xc3]), () => undefined);
  assertProtocolError(() => invalidEof.finish(), "invalid_utf8");

  const partial = new CodexJsonlDecoder();
  partial.push(encoder.encode('{"id":1,"result":null}'), () => undefined);
  assertProtocolError(() => partial.finish(), "partial_line");

  const oversizedCarriageReturnAtEof = new CodexJsonlDecoder(1);
  oversizedCarriageReturnAtEof.push(encoder.encode("x\r"), () => undefined);
  assertProtocolError(() => oversizedCarriageReturnAtEof.finish(), "line_too_large");
});

test("JSONL decoder accepts exact LF and CRLF byte limits, including split CRLF", () => {
  const exactLine = '{"id":1,"result":"x"}';
  const exactBytes = encoder.encode(exactLine);
  const accepted = new CodexJsonlDecoder(exactBytes.byteLength);
  assert.equal(pushAndCollect(accepted, encoder.encode(`${exactLine}\n`)).length, 1);

  const acceptedCrlf = new CodexJsonlDecoder(exactBytes.byteLength);
  acceptedCrlf.push(encoder.encode(`${exactLine}\r`), () => undefined);
  assert.equal(pushAndCollect(acceptedCrlf, encoder.encode("\n")).length, 1);
  acceptedCrlf.finish();

  const rejected = new CodexJsonlDecoder(exactBytes.byteLength - 1);
  assertProtocolError(() => rejected.push(encoder.encode(`${exactLine}\n`), () => undefined), "line_too_large");
});

test("JSONL decoder enforces the configured default line limit", () => {
  const prefix = '{"id":1,"result":"';
  const suffix = '"}';
  const body = "x".repeat(CODEX_TRANSPORT_LIMITS.maxLineBytes - prefix.length - suffix.length);
  const decoder = new CodexJsonlDecoder();

  assert.equal(pushAndCollect(decoder, encoder.encode(`${prefix}${body}${suffix}\r\n`)).length, 1);
});

test("wire validation rejects ambiguous or unsupported outer envelopes", () => {
  const invalidLines = [
    '{"jsonrpc":"1.0","id":1,"result":null}',
    '{"id":1,"result":null,"error":{"code":1,"message":"no"}}',
    '{"id":9007199254740992,"result":null}',
    '{"id":1,"result":null,"extra":true}',
    '{"id":1,"error":{"code":1,"message":"no"},"extra":true}',
    '{"id":1,"method":"server/request","result":null}',
    '{"id":"server","method":"server/request","extra":true}',
    '{"id":9007199254740992,"method":"server/request"}',
    '{"method":""}',
    '{"method":"future/event","extra":true}',
    "[]",
  ];

  for (const line of invalidLines) {
    assertProtocolError(
      () => new CodexJsonlDecoder().push(encoder.encode(`${line}\n`), () => undefined),
      "invalid_envelope",
    );
  }
});

test("strict JSON parsing rejects duplicate object members before last-wins correlation", () => {
  const duplicateLines = [
    '{"id":1,"id":2,"result":null}',
    '{"id":1,"result":null,"result":false}',
    '{"id":1,"error":{"code":1,"code":2,"message":"no"}}',
    '{"id":"server","method":"server/request","trace":{"traceparent":null,"traceparent":"x"}}',
    '{"method":"future/event","params":{"nested":1,"nested":2}}',
    '{"\\u0069d":1,"id":2,"result":null}',
  ];
  for (const line of duplicateLines) {
    assertProtocolError(
      () => new CodexJsonlDecoder().push(encoder.encode(`${line}\n`), () => undefined),
      "invalid_envelope",
    );
  }
});

test("malformed JSON remains distinct when its incomplete prefix contains duplicate keys", () => {
  assertProtocolError(
    () => new CodexJsonlDecoder().push(encoder.encode('{"id":1,"id":2\n'), () => undefined),
    "malformed_json",
  );
});

test("a later invalid line in the same chunk does not erase an earlier valid envelope", () => {
  for (const suffix of ["{bad}\n", "{}\n", "\n"]) {
    const decoder = new CodexJsonlDecoder();
    const envelopes: CodexWireEnvelope[] = [];
    assert.throws(() =>
      decoder.push(encoder.encode(`{"id":1,"result":null}\n${suffix}`), (envelope) => envelopes.push(envelope)),
    );
    assert.deepEqual(envelopes, [{ kind: "response", id: 1, result: null }]);
  }

  const decoder = new CodexJsonlDecoder();
  const envelopes: CodexWireEnvelope[] = [];
  const valid = encoder.encode('{"id":1,"result":null}\n');
  const bytes = new Uint8Array(valid.byteLength + 3);
  bytes.set(valid);
  bytes.set([0xc3, 0x28, 0x0a], valid.byteLength);
  assertProtocolError(() => decoder.push(bytes, (envelope) => envelopes.push(envelope)), "invalid_utf8");
  assert.deepEqual(envelopes, [{ kind: "response", id: 1, result: null }]);
});

test("fake App Server framing fixture is decoded through a real stdout stream", async () => {
  const child = spawn(process.execPath, [fixturePath, "framing"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const decoder = new CodexJsonlDecoder();
  const envelopes: CodexWireEnvelope[] = [];
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk, (envelope) => envelopes.push(envelope)));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  decoder.finish();

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(envelopes, [
    { kind: "response", id: 1, result: { text: "分割" } },
    { kind: "notification", method: "future/event", params: { ok: true } },
  ]);
});

function decode(text: string): readonly CodexWireEnvelope[] {
  const decoder = new CodexJsonlDecoder();
  const envelopes = pushAndCollect(decoder, encoder.encode(text));
  decoder.finish();
  return envelopes;
}

function pushAndCollect(decoder: CodexJsonlDecoder, bytes: Uint8Array): CodexWireEnvelope[] {
  const envelopes: CodexWireEnvelope[] = [];
  decoder.push(bytes, (envelope) => envelopes.push(envelope));
  return envelopes;
}

function assertProtocolError(action: () => unknown, code: CodexWireProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof CodexWireProtocolError && error.code === code);
}

function caughtMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected action to throw");
}
