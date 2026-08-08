import { TextDecoder } from "node:util";

import { parseStrictJson as parseSharedStrictJson, StrictJsonError } from "../../shared/strict-json.js";
import { RUNTIME_IPC_LIMITS, decodeRuntimeIpcEnvelope, type RuntimeIpcEnvelope } from "./runtime-ipc-contract.js";
import { runtimeProtocolFailure } from "./runtime-ipc-common.js";

export class RuntimeIpcJsonlDecoder<TValue = RuntimeIpcEnvelope> {
  #decoder = createUtf8Decoder();
  #line = "";
  #lineBytes = 0;
  #lastLineByte: number | undefined;
  #ended = false;

  constructor(
    readonly maxLineBytes = RUNTIME_IPC_LIMITS.maxLineBytes,
    readonly maxBufferedBytes = RUNTIME_IPC_LIMITS.maxBufferedBytes,
    readonly decodeValue: (value: unknown) => TValue = decodeRuntimeIpcEnvelope as (value: unknown) => TValue,
  ) {
    if (
      !Number.isSafeInteger(maxLineBytes) ||
      maxLineBytes < 1 ||
      !Number.isSafeInteger(maxBufferedBytes) ||
      maxBufferedBytes < 1
    ) {
      throw new RangeError("Runtime IPC JSONL limits must be positive safe integers.");
    }
  }

  get hasPartialLine(): boolean {
    return this.#lineBytes > 0 || this.#line.length > 0;
  }

  push(chunk: Uint8Array, emit: (envelope: TValue) => void): void {
    if (this.#ended) throw new Error("Runtime IPC JSONL decoder has already ended.");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newlineOffset = chunk.indexOf(0x0a, offset);
      const end = newlineOffset === -1 ? chunk.byteLength : newlineOffset;
      const segment = chunk.subarray(offset, end);
      this.#lineBytes += segment.byteLength;
      if (this.#lineBytes > this.maxBufferedBytes) throw runtimeProtocolFailure("buffer_too_large");
      if (segment.byteLength > 0) this.#lastLineByte = segment.at(-1);
      const carriageReturnBytes = this.#lastLineByte === 0x0d ? 1 : 0;
      if (this.#lineBytes - carriageReturnBytes > this.maxLineBytes) {
        throw runtimeProtocolFailure("line_too_large");
      }
      this.#line += decodeUtf8(this.#decoder, segment, true);

      if (newlineOffset === -1) break;
      this.#line += decodeUtf8(this.#decoder, new Uint8Array(), false);
      emit(this.#finishLine());
      offset = newlineOffset + 1;
    }
  }

  finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#lineBytes > this.maxBufferedBytes) throw runtimeProtocolFailure("buffer_too_large");
    if (this.#lineBytes > this.maxLineBytes) throw runtimeProtocolFailure("line_too_large");
    const tail = decodeUtf8(this.#decoder, new Uint8Array(), false);
    if (this.#lineBytes > 0 || this.#line.length > 0 || tail.length > 0) {
      throw runtimeProtocolFailure("partial_line");
    }
  }

  #finishLine(): TValue {
    const line = this.#line.endsWith("\r") ? this.#line.slice(0, -1) : this.#line;
    this.#decoder = createUtf8Decoder();
    this.#line = "";
    this.#lineBytes = 0;
    this.#lastLineByte = undefined;
    if (line.length === 0) throw runtimeProtocolFailure("empty_line");
    return this.decodeValue(parseStrictJson(line));
  }
}

export function parseStrictJson(text: string): unknown {
  try {
    return parseSharedStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw runtimeProtocolFailure(error.code);
    }
    throw error;
  }
}

function createUtf8Decoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: true });
}

function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array, stream: boolean): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw runtimeProtocolFailure("invalid_utf8");
  }
}
