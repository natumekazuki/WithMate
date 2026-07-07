import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  MEMORY_PROTECTED_OBJECT_ENVELOPE_OVERHEAD_BYTES,
  encryptMemoryProtectedObjectPayload,
  type MemoryProtectedObjectKey,
} from "./memory-protected-object-crypto.js";
import {
  createMemoryProtectedObjectId,
  type MemoryProtectedObjectStore,
} from "./memory-protected-object-store.js";
import type { MemoryAppendFileInput } from "../src/memory-v6/memory-contract.js";
import type {
  MemoryV6AppendProtectedObjectInput,
  MemoryV6ProtectedObjectMediaKind,
} from "./memory-v6-storage.js";

export type MemoryProtectedObjectKeyProvider = {
  getOrCreateActiveKey(): Promise<MemoryProtectedObjectKey>;
};

export type MemoryProtectedObjectPayloadStore = Pick<MemoryProtectedObjectStore, "writeObject">;

export const MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;
export const MEMORY_PROTECTED_OBJECT_MAX_STORED_BYTES =
  MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES + MEMORY_PROTECTED_OBJECT_ENVELOPE_OVERHEAD_BYTES;

export type MemoryProtectedObjectImportErrorCode =
  | "MEMORY_INVALID_FIELD"
  | "MEMORY_FIELD_TOO_LARGE"
  | "MEMORY_FILE_IMPORT_FAILED";

export class MemoryProtectedObjectImportError extends Error {
  constructor(
    readonly code: MemoryProtectedObjectImportErrorCode,
    readonly field: "path" | "summary" | "files",
    message: string,
  ) {
    super(message);
    this.name = "MemoryProtectedObjectImportError";
  }
}

export type PrepareMemoryProtectedObjectFileInput = {
  entryId: string;
  file: MemoryAppendFileInput;
};

export type PrepareMemoryProtectedObjectFileDependencies = {
  keyStore: MemoryProtectedObjectKeyProvider;
  objectStore: MemoryProtectedObjectPayloadStore;
};

export type MemoryProtectedObjectInputFileInspection = {
  role: NonNullable<MemoryAppendFileInput["role"]>;
  originalBytes: number;
  mediaKind: MemoryV6ProtectedObjectMediaKind;
  contentType: string;
  displayName: string;
  summary: string;
};

export async function prepareMemoryProtectedObjectFile(
  dependencies: PrepareMemoryProtectedObjectFileDependencies,
  input: PrepareMemoryProtectedObjectFileInput,
): Promise<MemoryV6AppendProtectedObjectInput> {
  const inspected = await inspectMemoryProtectedObjectInputFile(input.file);
  const objectId = createMemoryProtectedObjectId();
  let key: MemoryProtectedObjectKey;
  let plaintext: Buffer;
  try {
    key = await dependencies.keyStore.getOrCreateActiveKey();
    plaintext = await readFile(input.file.path);
  } catch {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_FILE_IMPORT_FAILED",
      "files",
      "Memory protected object import failed.",
    );
  }
  if (plaintext.byteLength !== inspected.originalBytes) {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_INVALID_FIELD",
      "path",
      "Memory protected object input file changed during import.",
    );
  }

  let encrypted: ReturnType<typeof encryptMemoryProtectedObjectPayload>;
  let writeResult: Awaited<ReturnType<MemoryProtectedObjectPayloadStore["writeObject"]>>;
  try {
    encrypted = encryptMemoryProtectedObjectPayload({
      plaintext,
      key,
      aad: createMemoryProtectedObjectAad({
        entryId: input.entryId,
        objectId,
      }),
    });
    writeResult = await dependencies.objectStore.writeObject({
      objectId,
      payload: encrypted.encryptedPayload,
    });
  } catch {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_FILE_IMPORT_FAILED",
      "files",
      "Memory protected object import failed.",
    );
  }

  return {
    objectId,
    role: inspected.role,
    mediaKind: inspected.mediaKind,
    contentType: inspected.contentType,
    displayName: inspected.displayName,
    summary: inspected.summary,
    originalBytes: inspected.originalBytes,
    storedBytes: writeResult.storedBytes,
    sha256: encrypted.sha256,
    keyId: encrypted.keyId,
  };
}

export async function inspectMemoryProtectedObjectInputFile(
  file: MemoryAppendFileInput,
): Promise<MemoryProtectedObjectInputFileInspection> {
  let stats;
  try {
    stats = await stat(file.path);
  } catch {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_INVALID_FIELD",
      "path",
      "Memory protected object input file is not readable.",
    );
  }

  if (!stats.isFile()) {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_INVALID_FIELD",
      "path",
      "Memory protected object input path must be a file.",
    );
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_INVALID_FIELD",
      "path",
      "Memory protected object input file size is invalid.",
    );
  }
  if (stats.size > MEMORY_PROTECTED_OBJECT_MAX_ORIGINAL_BYTES) {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_FIELD_TOO_LARGE",
      "path",
      "Memory protected object input file exceeds per-file size limit.",
    );
  }

  const contentType = file.contentType?.trim() ?? "";
  const displayName = file.displayName?.trim() ?? "";
  const role = file.role ?? "other";
  const summary = file.summary.trim();
  if (summary.length === 0) {
    throw new MemoryProtectedObjectImportError(
      "MEMORY_INVALID_FIELD",
      "summary",
      "Memory protected object file summary is required.",
    );
  }

  return {
    role,
    originalBytes: stats.size,
    mediaKind: inferMemoryProtectedObjectMediaKind({
      role,
      contentType,
      path: file.path,
    }),
    contentType,
    displayName,
    summary,
  };
}

export function createMemoryProtectedObjectAad(input: {
  entryId: string;
  objectId: string;
}): Buffer {
  return Buffer.from(`memory-v6\0${input.entryId}\0${input.objectId}`, "utf8");
}

export function inferMemoryProtectedObjectMediaKind(input: {
  role?: MemoryAppendFileInput["role"];
  contentType?: string;
  path?: string;
}): MemoryV6ProtectedObjectMediaKind {
  if (input.role === "source") {
    return "source";
  }

  const contentType = input.contentType?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("text/") || contentType === "application/json") {
    return "text";
  }
  if (contentType === "application/pdf") {
    return "document";
  }
  if (
    contentType === "application/zip" ||
    contentType === "application/gzip" ||
    contentType === "application/x-tar" ||
    contentType === "application/x-7z-compressed"
  ) {
    return "archive";
  }

  const extension = input.path ? extname(input.path).toLowerCase() : "";
  if ([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html"].includes(extension)) {
    return "text";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) {
    return "image";
  }
  if ([".zip", ".gz", ".tgz", ".tar", ".7z"].includes(extension)) {
    return "archive";
  }
  if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].includes(extension)) {
    return "document";
  }

  return "other";
}
