import { CODEX_TRANSPORT_LIMITS } from "./transport-limits.js";

export type CodexDiagnosticSnapshot = Readonly<{
  stderr: Readonly<{
    observedChunks: number;
    observedBytes: number;
    retainedBytes: number;
    truncated: boolean;
    redaction: "content_omitted";
    summary: "Codex App Server emitted stderr output." | null;
  }>;
}>;

export class CodexDiagnosticCollector {
  #observedChunks = 0;
  #observedBytes = 0;
  #retainedBytes = 0;
  #truncated = false;

  constructor(readonly maxStderrBytes = CODEX_TRANSPORT_LIMITS.maxStderrBytes) {
    if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1) {
      throw new RangeError("maxStderrBytes must be a positive safe integer.");
    }
  }

  observeStderr(chunk: Uint8Array): void {
    this.#observedChunks = saturatingAdd(this.#observedChunks, 1);
    this.#observedBytes = saturatingAdd(this.#observedBytes, chunk.byteLength);
    const remaining = this.maxStderrBytes - this.#retainedBytes;
    this.#retainedBytes += Math.min(remaining, chunk.byteLength);
    if (chunk.byteLength > remaining) this.#truncated = true;
  }

  snapshot(): CodexDiagnosticSnapshot {
    return {
      stderr: {
        observedChunks: this.#observedChunks,
        observedBytes: this.#observedBytes,
        retainedBytes: this.#retainedBytes,
        truncated: this.#truncated,
        redaction: "content_omitted",
        summary: this.#observedChunks === 0 ? null : "Codex App Server emitted stderr output.",
      },
    };
  }
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}
