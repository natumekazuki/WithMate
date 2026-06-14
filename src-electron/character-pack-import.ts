import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { readFileSync } from "node:fs";

import {
  CHARACTER_DEFINITION_MAX_BYTES,
  CHARACTER_NOTES_MAX_BYTES,
  parseCharacterDefinitionMarkdown,
} from "../src/character/character-definition.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export type CharacterPackAsset = {
  fileName: string;
  data: Buffer;
};

export type ParsedCharacterPack = {
  definitionMarkdown: string;
  notesMarkdown: string;
  name: string;
  description: string;
  iconAsset: CharacterPackAsset | null;
  importedFiles: string[];
};

type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function isSafeZipEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return normalized.length > 0
    && !normalized.startsWith("/")
    && !normalized.includes("\0")
    && !normalized.split("/").includes("..")
    && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Character pack zip の central directory が見つかりません。");
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > buffer.length) {
    throw new Error("Character pack zip の central directory が壊れています。");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Character pack zip の entry 情報が壊れています。");
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const name = buffer.toString("utf8", nameStart, nameEnd).replace(/\\/g, "/");
    if (!isSafeZipEntryName(name)) {
      throw new Error(`Character pack zip に unsafe path が含まれています: ${name}`);
    }
    if (!name.endsWith("/")) {
      if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw new Error(`Character pack zip entry が大きすぎます: ${name}`);
      }
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    offset = nameEnd + extraLength + commentLength;
  }

  const totalUncompressedBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new Error("Character pack zip の展開サイズが大きすぎます。");
  }

  return entries;
}

function readZipEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Character pack zip の local header が壊れています: ${entry.name}`);
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`Character pack zip の entry data が壊れています: ${entry.name}`);
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.compressionMethod === 0) {
    data = Buffer.from(compressed);
  } else if (entry.compressionMethod === 8) {
    data = inflateRawSync(compressed);
  } else {
    throw new Error(`Character pack zip の compression method は未対応です: ${entry.name}`);
  }

  if (data.byteLength !== entry.uncompressedSize) {
    throw new Error(`Character pack zip の entry size が一致しません: ${entry.name}`);
  }
  if (data.byteLength > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw new Error(`Character pack zip entry が大きすぎます: ${entry.name}`);
  }

  return data;
}

function findPackEntry(entries: ZipEntry[], fileName: string): ZipEntry | null {
  const normalizedFileName = fileName.toLowerCase();
  return entries.find((entry) => path.posix.basename(entry.name).toLowerCase() === normalizedFileName) ?? null;
}

function readTextEntry(buffer: Buffer, entry: ZipEntry | null, maxBytes: number): string {
  if (!entry) {
    return "";
  }
  const data = readZipEntryData(buffer, entry);
  if (data.byteLength > maxBytes) {
    throw new Error(`${path.posix.basename(entry.name)} が大きすぎます。`);
  }
  return data.toString("utf8");
}

function buildImportedNotes(entries: ZipEntry[], buffer: Buffer): string {
  const notes = readTextEntry(buffer, findPackEntry(entries, "character-notes.md"), CHARACTER_NOTES_MAX_BYTES);
  const importedSection = (fileName: string, heading: string, maxBytes = 64 * 1024): string => {
    const content = readTextEntry(buffer, findPackEntry(entries, fileName), maxBytes).trim();
    return content ? `## ${heading}\n\n${content}\n` : "";
  };
  const assetManifest = readTextEntry(buffer, findPackEntry(entries, "asset-manifest.json"), 64 * 1024).trim();
  const sections = [
    notes || "# Character Notes\n",
    importedSection("README.md", "Imported Pack README"),
    importedSection("source-report.md", "Imported Source Report"),
    importedSection("review-checklist.md", "Imported Review Checklist"),
    assetManifest ? `## Imported Asset Manifest\n\n\`\`\`json\n${assetManifest}\n\`\`\`\n` : "",
  ];
  const joined = sections.filter(Boolean).join("\n\n").trimEnd() + "\n";
  if (Buffer.byteLength(joined, "utf8") > CHARACTER_NOTES_MAX_BYTES) {
    throw new Error("import 後の character-notes.md が大きすぎます。");
  }
  return joined;
}

function findIconAsset(entries: ZipEntry[], buffer: Buffer): CharacterPackAsset | null {
  const imageEntry = entries.find((entry) => {
    const extension = path.posix.extname(entry.name).toLowerCase();
    return entry.name.includes("/") && IMAGE_EXTENSIONS.has(extension);
  });
  if (!imageEntry) {
    return null;
  }

  return {
    fileName: path.posix.basename(imageEntry.name).replace(/[^a-zA-Z0-9._-]/g, "-") || "icon.png",
    data: readZipEntryData(buffer, imageEntry),
  };
}

export function parseCharacterPackZipFile(filePath: string): ParsedCharacterPack {
  if (path.extname(filePath).toLowerCase() !== ".zip") {
    throw new Error("Character pack は .zip を選択してください。");
  }

  const buffer = readFileSync(filePath);
  if (buffer.byteLength > MAX_ZIP_BYTES) {
    throw new Error("Character pack zip が大きすぎます。");
  }

  const entries = readZipEntries(buffer);
  const definitionEntry = findPackEntry(entries, "character.md");
  if (!definitionEntry) {
    throw new Error("Character pack に character.md が含まれていません。");
  }

  const definitionMarkdown = readTextEntry(buffer, definitionEntry, CHARACTER_DEFINITION_MAX_BYTES);
  const parsedDefinition = parseCharacterDefinitionMarkdown(definitionMarkdown);
  if (!parsedDefinition.ok) {
    throw new Error(`character.md validation failed: ${parsedDefinition.issues.map((issue) => issue.code).join(", ")}`);
  }

  return {
    definitionMarkdown,
    notesMarkdown: buildImportedNotes(entries, buffer),
    name: parsedDefinition.value.frontmatter.name,
    description: parsedDefinition.value.frontmatter.description,
    iconAsset: findIconAsset(entries, buffer),
    importedFiles: entries.map((entry) => entry.name),
  };
}
