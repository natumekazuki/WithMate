import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  decryptMemoryProtectedObjectPayload,
  sha256Hex,
  type MemoryProtectedObjectKey,
} from "./memory-protected-object-crypto.js";
import { createMemoryProtectedObjectAad } from "./memory-protected-object-importer.js";
import type { MemoryProtectedObjectStore } from "./memory-protected-object-store.js";
import type { MemoryV6ProtectedObjectExportMetadata } from "./memory-v6-storage.js";

export type MemoryProtectedObjectKeyReader = {
  readKey(keyId: string): Promise<MemoryProtectedObjectKey | null>;
};

export type MemoryProtectedObjectPayloadReader = Pick<MemoryProtectedObjectStore, "readObject">;

export type ExportMemoryProtectedObjectFileDependencies = {
  keyStore: MemoryProtectedObjectKeyReader;
  objectStore: MemoryProtectedObjectPayloadReader;
};

export type ExportMemoryProtectedObjectFileInput = {
  metadata: MemoryV6ProtectedObjectExportMetadata;
  outputPath: string;
};

export type ExportMemoryProtectedObjectFileResult = {
  bytesWritten: number;
};

export type ExportMemoryProtectedObjectFilesInput = {
  metadata: readonly MemoryV6ProtectedObjectExportMetadata[];
  outputDirectoryPath: string;
};

export type ExportMemoryProtectedObjectFilesResult = {
  files: Array<{
    objectId: string;
    outputPath: string;
    bytesWritten: number;
    contentType: string;
    displayName: string;
  }>;
};

export async function exportMemoryProtectedObjectFile(
  dependencies: ExportMemoryProtectedObjectFileDependencies,
  input: ExportMemoryProtectedObjectFileInput,
): Promise<ExportMemoryProtectedObjectFileResult> {
  const key = await dependencies.keyStore.readKey(input.metadata.keyId);
  if (!key) {
    throw new Error("Memory protected object key is not available.");
  }

  const encryptedPayload = await dependencies.objectStore.readObject(input.metadata.objectId);
  if (encryptedPayload.byteLength !== input.metadata.storedBytes) {
    throw new Error("Memory protected object payload size does not match metadata.");
  }
  if (sha256Hex(encryptedPayload) !== input.metadata.sha256) {
    throw new Error("Memory protected object payload digest does not match metadata.");
  }

  const plaintext = decryptMemoryProtectedObjectPayload({
    encryptedPayload,
    key,
    aad: createMemoryProtectedObjectAad({
      entryId: input.metadata.entryId,
      objectId: input.metadata.objectId,
    }),
  });
  if (plaintext.byteLength !== input.metadata.originalBytes) {
    throw new Error("Memory protected object plaintext size does not match metadata.");
  }

  await writeFile(input.outputPath, plaintext, { flag: "wx" });
  return { bytesWritten: plaintext.byteLength };
}

export async function exportMemoryProtectedObjectFiles(
  dependencies: ExportMemoryProtectedObjectFileDependencies,
  input: ExportMemoryProtectedObjectFilesInput,
): Promise<ExportMemoryProtectedObjectFilesResult> {
  await mkdir(input.outputDirectoryPath, { recursive: true });
  const files = [];
  for (const metadata of input.metadata) {
    const outputPath = path.join(input.outputDirectoryPath, buildExportFileName(metadata));
    const result = await exportMemoryProtectedObjectFile(dependencies, {
      metadata,
      outputPath,
    });
    files.push({
      objectId: metadata.objectId,
      outputPath,
      bytesWritten: result.bytesWritten,
      contentType: metadata.contentType,
      displayName: metadata.displayName,
    });
  }
  return { files };
}

function buildExportFileName(metadata: MemoryV6ProtectedObjectExportMetadata): string {
  const displayName = metadata.displayName.trim();
  if (!displayName) {
    return `${metadata.objectId}.bin`;
  }

  const baseName = path.basename(displayName.replace(/\\/g, "/"));
  const safeName = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return safeName
    ? `${metadata.objectId}-${safeName}`
    : `${metadata.objectId}.bin`;
}
