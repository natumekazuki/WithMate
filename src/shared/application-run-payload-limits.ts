import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "./allowed-additional-directories.js";
import { APPLICATION_RUN_LIMITS } from "./application-run-model.js";
import { MESSAGE_CONTENT_LIMITS } from "./message-content.js";

const MAX_JSON_STRING_BYTES_PER_UTF16_CODE_UNIT = 6;
const MAX_JSON_STRUCTURE_BYTES = 64 * 1024;
const CODEX_TEXT_ELEMENT_WIRE_OVERHEAD_BYTES = 32;

function maxJsonStringBytes(maxCharacters: number): number {
  return 2 + maxCharacters * MAX_JSON_STRING_BYTES_PER_UTF16_CODE_UNIT;
}

const executionSnapshotEnvelopeBytes =
  maxJsonStringBytes(APPLICATION_RUN_LIMITS.maxIdentifierLength) * 2 +
  maxJsonStringBytes(APPLICATION_RUN_LIMITS.maxExecutionSettingLength) * 2 +
  maxJsonStringBytes(ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength) +
  MAX_JSON_STRUCTURE_BYTES;

const providerRequestEnvelopeBytes =
  maxJsonStringBytes(APPLICATION_RUN_LIMITS.maxExecutionSettingLength) * 2 +
  maxJsonStringBytes(ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength) * 2 +
  MAX_JSON_STRUCTURE_BYTES;

const codexWireEnvelopeBytes =
  MESSAGE_CONTENT_LIMITS.maxBlocks * CODEX_TEXT_ELEMENT_WIRE_OVERHEAD_BYTES + MAX_JSON_STRUCTURE_BYTES;

export const APPLICATION_RUN_PAYLOAD_LIMITS = Object.freeze({
  executionSnapshotMaxJsonBytes: ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes + executionSnapshotEnvelopeBytes,
  providerRequestMaxJsonBytes:
    MESSAGE_CONTENT_LIMITS.maxJsonBytes +
    ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes +
    providerRequestEnvelopeBytes,
  codexWireMaxLineBytes:
    MESSAGE_CONTENT_LIMITS.maxJsonBytes +
    ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes +
    providerRequestEnvelopeBytes +
    codexWireEnvelopeBytes,
} as const);
