import type { Writable } from "node:stream";

import { parseStrictJson } from "./strict-json.js";
import { CodexWireWriteError } from "./transport-error.js";
import { CODEX_TRANSPORT_LIMITS, type CodexTransportLimits } from "./transport-limits.js";
import { decodeCodexWireEnvelope } from "./wire-envelope.js";
import type { CodexClientWireMessage, CodexWireWriter } from "./protocol-session.js";

type QueuedWrite = {
  message: CodexClientWireMessage;
  bytes: Buffer;
  onWriteStarted: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

export class CodexStdioWireWriter implements CodexWireWriter {
  readonly #queue: QueuedWrite[] = [];
  readonly #limits: CodexTransportLimits;
  #active: QueuedWrite | undefined;
  #queuedBytes = 0;
  #closing = false;
  #failed = false;

  constructor(
    readonly stream: Writable,
    readonly onFatalFailure: () => void,
    limits: CodexTransportLimits = CODEX_TRANSPORT_LIMITS,
  ) {
    this.#limits = limits;
    stream.on("error", () => this.#fail());
    stream.on("close", () => {
      if (!this.#closing) this.#fail();
    });
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  write(message: CodexClientWireMessage, onWriteStarted: () => void): Promise<void> {
    if (this.#closing || this.#failed || this.stream.destroyed || !this.stream.writable) {
      return Promise.reject(new CodexWireWriteError({ outcome: "not_sent", code: "stream_unavailable" }));
    }

    const bytes = encodeCodexWireMessage(message, this.#limits.maxLineBytes);
    if (bytes instanceof CodexWireWriteError) return Promise.reject(bytes);
    if (this.#queuedBytes + bytes.byteLength > this.#limits.maxQueuedWriteBytes) {
      return Promise.reject(new CodexWireWriteError({ outcome: "not_sent", code: "queue_full" }));
    }

    this.#queuedBytes += bytes.byteLength;
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ message, bytes, onWriteStarted, resolve, reject, settled: false });
      this.#drain();
    });
  }

  cancelBeforeSend(message: CodexClientWireMessage): boolean {
    const entry = this.#queue.find((candidate) => candidate.message === message);
    if (entry === undefined) return false;
    this.#settle(entry, new CodexWireWriteError({ outcome: "not_sent", code: "stream_unavailable" }));
    return true;
  }

  shutdown(): void {
    if (this.#closing) return;
    this.#closing = true;
    for (const entry of [...this.#queue]) {
      this.#settle(entry, new CodexWireWriteError({ outcome: "not_sent", code: "stream_unavailable" }));
    }
    if (this.#active !== undefined) {
      this.#settle(this.#active, new CodexWireWriteError({ outcome: "unknown", code: "stream_unavailable" }));
    }
    this.#queue.length = 0;
    if (!this.stream.destroyed) this.stream.end();
  }

  #drain(): void {
    if (this.#active !== undefined || this.#closing || this.#failed) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    this.#active = entry;
    try {
      entry.onWriteStarted();
      this.stream.write(entry.bytes, (error: Error | null | undefined) => {
        if (error === null || error === undefined) this.#settle(entry);
        else this.#fail();
      });
    } catch {
      this.#fail();
    }
  }

  #settle(entry: QueuedWrite, error?: CodexWireWriteError): void {
    if (entry.settled) return;
    entry.settled = true;
    this.#queuedBytes -= entry.bytes.byteLength;
    if (this.#active === entry) this.#active = undefined;
    const queuedIndex = this.#queue.indexOf(entry);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    if (error === undefined) entry.resolve();
    else entry.reject(error);
    this.#drain();
  }

  #fail(): void {
    if (this.#failed || this.#closing) return;
    this.#failed = true;
    for (const entry of [...this.#queue]) {
      this.#settle(entry, new CodexWireWriteError({ outcome: "not_sent", code: "stream_unavailable" }));
    }
    if (this.#active !== undefined) {
      this.#settle(this.#active, new CodexWireWriteError({ outcome: "unknown", code: "stream_unavailable" }));
    }
    this.#queue.length = 0;
    queueMicrotask(this.onFatalFailure);
  }
}

export function encodeCodexWireMessage(
  message: CodexClientWireMessage,
  maxLineBytes: number,
): Buffer | CodexWireWriteError {
  let json: string;
  try {
    json = JSON.stringify(message);
    decodeCodexWireEnvelope(parseStrictJson(json));
  } catch {
    return new CodexWireWriteError({ outcome: "not_sent", code: "invalid_message" });
  }
  const bytes = Buffer.from(`${json}\n`, "utf8");
  if (bytes.byteLength - 1 > maxLineBytes) {
    return new CodexWireWriteError({ outcome: "not_sent", code: "invalid_message" });
  }
  return bytes;
}
