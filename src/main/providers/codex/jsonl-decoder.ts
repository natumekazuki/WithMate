import { TextDecoder } from "node:util";

import { parseStrictJson } from "./strict-json.js";
import { CODEX_TRANSPORT_LIMITS } from "./transport-limits.js";
import { CodexWireProtocolError, decodeCodexWireEnvelope, type CodexWireEnvelope } from "./wire-envelope.js";

export class CodexJsonlDecoder {
  #decoder = createUtf8Decoder();
  #line = "";
  #lineBytes = 0;
  #lastLineByte: number | undefined;
  #ended = false;

  constructor(readonly maxLineBytes = CODEX_TRANSPORT_LIMITS.maxLineBytes) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer.");
    }
  }

  push(chunk: Uint8Array, emit: (envelope: CodexWireEnvelope) => void): void {
    if (this.#ended) {
      throw new Error("Codex JSONL decoder has already ended.");
    }

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newlineOffset = chunk.indexOf(0x0a, offset);
      const end = newlineOffset === -1 ? chunk.byteLength : newlineOffset;
      const segment = chunk.subarray(offset, end);
      this.#lineBytes += segment.byteLength;
      if (segment.byteLength > 0) this.#lastLineByte = segment.at(-1);
      const delimiterBytes = newlineOffset !== -1 && this.#lastLineByte === 0x0d ? 1 : 0;
      const contentBytes = this.#lineBytes - delimiterBytes;
      const deferredCarriageReturn =
        newlineOffset === -1 && this.#lineBytes === this.maxLineBytes + 1 && this.#lastLineByte === 0x0d;
      if (contentBytes > this.maxLineBytes && !deferredCarriageReturn) {
        throw new CodexWireProtocolError("line_too_large");
      }
      this.#line += this.#decode(segment, true);

      if (newlineOffset === -1) break;
      this.#line += this.#decode(new Uint8Array(), false);
      emit(this.#finishLine());
      offset = newlineOffset + 1;
    }
  }

  finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#lineBytes > this.maxLineBytes) {
      throw new CodexWireProtocolError("line_too_large");
    }
    const tail = this.#decode(new Uint8Array(), false);
    if (this.#lineBytes > 0 || this.#line.length > 0 || tail.length > 0) {
      throw new CodexWireProtocolError("partial_line");
    }
  }

  #finishLine(): CodexWireEnvelope {
    const line = this.#line.endsWith("\r") ? this.#line.slice(0, -1) : this.#line;
    this.#decoder = createUtf8Decoder();
    this.#line = "";
    this.#lineBytes = 0;
    this.#lastLineByte = undefined;
    if (line.length === 0) {
      throw new CodexWireProtocolError("empty_line");
    }

    return decodeCodexWireEnvelope(parseStrictJson(line));
  }

  #decode(bytes: Uint8Array, stream: boolean): string {
    try {
      return this.#decoder.decode(bytes, { stream });
    } catch {
      throw new CodexWireProtocolError("invalid_utf8");
    }
  }
}

function createUtf8Decoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: true });
}
