import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CHARACTER_DEFINITION_MAX_BYTES,
  CHARACTER_NOTES_MAX_BYTES,
  parseCharacterDefinitionMarkdown,
} from "../src/character/character-definition.js";

const MAX_IMPORTED_ASSET_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export type CharacterImportAsset = {
  fileName: string;
  data: Buffer;
};

export type ParsedCharacterImportFiles = {
  definitionMarkdown: string;
  notesMarkdown: string;
  name: string;
  description: string;
  assets: CharacterImportAsset[];
  iconFileName: string | null;
  importedFiles: string[];
};

function sanitizeImportedFileName(filePath: string): string {
  return path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "-") || "asset";
}

function createUniqueImportedFileName(filePath: string, usedNames: Set<string>): string {
  const sanitized = sanitizeImportedFileName(filePath);
  const extension = path.extname(sanitized);
  const stem = extension ? sanitized.slice(0, -extension.length) : sanitized;
  let candidate = sanitized;
  for (let index = 2; usedNames.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem}-${index}${extension}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function findSelectedFile(filePaths: string[], fileName: string): string | null {
  const normalizedFileName = fileName.toLowerCase();
  return filePaths.find((filePath) => path.basename(filePath).toLowerCase() === normalizedFileName) ?? null;
}

function readFileBuffer(filePath: string, maxBytes: number, label = path.basename(filePath)): Buffer {
  const buffer = readFileSync(filePath);
  if (buffer.byteLength > maxBytes) {
    throw new Error(`${label} が大きすぎます。`);
  }
  return buffer;
}

function readTextFile(filePaths: string[], fileName: string, maxBytes: number): string {
  const filePath = findSelectedFile(filePaths, fileName);
  if (!filePath) {
    return "";
  }
  return readFileBuffer(filePath, maxBytes, fileName).toString("utf8");
}

function buildImportedNotes(filePaths: string[]): string {
  const notes = readTextFile(filePaths, "character-notes.md", CHARACTER_NOTES_MAX_BYTES);
  const importedSection = (fileName: string, heading: string, maxBytes = 64 * 1024): string => {
    const content = readTextFile(filePaths, fileName, maxBytes).trim();
    return content ? `## ${heading}\n\n${content}\n` : "";
  };
  const assetManifest = readTextFile(filePaths, "asset-manifest.json", 64 * 1024).trim();
  const sections = [
    notes || "# Character Notes\n",
    importedSection("README.md", "Imported README"),
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

function collectImageAssets(filePaths: string[]): CharacterImportAsset[] {
  const usedNames = new Set<string>();
  return filePaths
    .filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .map((filePath) => ({
      fileName: createUniqueImportedFileName(filePath, usedNames),
      data: readFileBuffer(filePath, MAX_IMPORTED_ASSET_BYTES),
    }));
}

export function parseCharacterImportFiles(filePaths: string[]): ParsedCharacterImportFiles {
  if (filePaths.length === 0) {
    throw new Error("import する Character file を選択してください。");
  }

  const definitionPath = findSelectedFile(filePaths, "character.md");
  if (!definitionPath) {
    throw new Error("import するファイルに character.md が含まれていません。");
  }

  const definitionMarkdown = readFileBuffer(
    definitionPath,
    CHARACTER_DEFINITION_MAX_BYTES,
    "character.md",
  ).toString("utf8");
  const parsedDefinition = parseCharacterDefinitionMarkdown(definitionMarkdown);
  if (!parsedDefinition.ok) {
    throw new Error(`character.md validation failed: ${parsedDefinition.issues.map((issue) => issue.code).join(", ")}`);
  }

  const assets = collectImageAssets(filePaths);

  return {
    definitionMarkdown,
    notesMarkdown: buildImportedNotes(filePaths),
    name: parsedDefinition.value.frontmatter.name,
    description: parsedDefinition.value.frontmatter.description,
    assets,
    iconFileName: assets[0]?.fileName ?? null,
    importedFiles: filePaths.map((filePath) => path.basename(filePath)),
  };
}
