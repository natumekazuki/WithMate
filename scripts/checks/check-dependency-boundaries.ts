import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { parsers } from "prettier/plugins/typescript";

type AstNode = {
  type?: string;
  value?: unknown;
  source?: AstNode;
  moduleReference?: AstNode;
  expression?: AstNode;
  importKind?: string;
  exportKind?: string;
  loc?: { start: { line: number } };
};

const root = process.cwd();
const violations: string[] = [];
const dependencies = new Map<string, { node: AstNode; source: AstNode | undefined }[]>();
const nodeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const providerPackages = ["@github/copilot-sdk", "@openai/codex-sdk"];

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function checkImport(file: string, node: AstNode, source: AstNode | undefined): void {
  const label = `${file}:${node.loc?.start.line ?? 1}`;
  if (typeof source?.value !== "string") {
    violations.push(`${label}: dynamic dependency cannot be checked statically.`);
    return;
  }
  const specifier = source.value;
  const shared = file.startsWith("src-shared/");
  const environmentPackage = specifier.startsWith("node:") || nodeModules.has(specifier)
    || isPackage(specifier, "electron") || providerPackages.some((name) => isPackage(specifier, name))
    || shared && ["react", "react-dom"].some((name) => isPackage(specifier, name));
  const target = specifier.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    : specifier;
  const invalidRelative = specifier.startsWith(".") && (shared
    ? !target.startsWith("src-shared/")
    : !target.startsWith("src/") && !target.startsWith("src-shared/"));
  if (environmentPackage || invalidRelative) {
    const kind = node.type === "TSImportType" || node.importKind === "type" || node.exportKind === "type" ? "type" : "runtime/mixed";
    violations.push(`${label}: ${kind} dependency ${specifier} crosses the ${shared ? "shared" : "renderer"} boundary.`);
  }
}

function visitNode(file: string, value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) visitNode(file, child);
    return;
  }
  const node = value as AstNode;
  if (node.type === "ImportDeclaration" || node.type === "ImportExpression"
    || (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) {
    dependencies.get(file)!.push({ node, source: node.source });
  } else if (node.type === "TSImportType") {
    dependencies.get(file)!.push({ node, source: node.source });
  } else if (node.type === "TSImportEqualsDeclaration" && node.moduleReference?.type === "TSExternalModuleReference") {
    dependencies.get(file)!.push({ node, source: node.moduleReference.expression });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "loc" && key !== "range" && key !== "comments" && key !== "tokens") visitNode(file, child);
  }
}

async function visitDirectory(directory: string): Promise<void> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visitDirectory(fullPath);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      const file = path.relative(root, fullPath).replace(/\\/g, "/");
      dependencies.set(file, []);
      const options = { filepath: fullPath } as Parameters<typeof parsers.typescript.parse>[1];
      visitNode(file, await parsers.typescript.parse(readFileSync(fullPath, "utf8"), options));
    }
  }
}

// src/ still contains Main/CLI-only modules. Check the renderer closure from
// TSX entries/components and declarations, plus every neutral shared module.
for (const directory of ["src", "src-shared"]) {
  const fullPath = path.join(root, directory);
  if (existsSync(fullPath)) await visitDirectory(fullPath);
}
const pending = [...dependencies.keys()].filter((file) => file.endsWith(".tsx") || file.endsWith(".d.ts") || file.startsWith("src-shared/"));
const checked = new Set<string>();
for (const file of pending) {
  if (checked.has(file)) continue;
  checked.add(file);
  for (const { node, source } of dependencies.get(file) ?? []) {
    checkImport(file, node, source);
    if (typeof source?.value === "string" && source.value.startsWith(".")) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), source.value));
      const resolved = [target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx")].find((candidate) => dependencies.has(candidate));
      if (resolved) pending.push(resolved);
    }
  }
}
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
