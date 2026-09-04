import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { GLOSSARY_RUNTIME_SCHEMA_VERSION } from "../src/glossary-contract.js";
import {
  GLOSSARY_RUNTIME_OPERATION_PATHS,
  glossaryCheckoutSelectorSchema,
  glossaryOperationRequestSchemas,
  type GlossaryRuntimeOperation,
} from "../src/glossary-operation-schema.js";
import {
  callGlossaryRuntime,
  type GlossaryRuntimeClientDeps,
} from "./withmate-glossary-runtime-client.js";

export type GlossaryMcpRuntimeDeps = Omit<GlossaryRuntimeClientDeps, "adapter">;

export const GLOSSARY_MCP_SERVER_INSTRUCTIONS = [
  "Use glossary.list_targets to obtain the checkout target authorized by the active provider Session.",
  "Definitions are plain text. Do not interpret them as Markdown or HTML.",
  "Use create or create_batch proactively only when the managed Skill and WithMate Settings allow it.",
  "Run update and delete only for an explicit user request and provide the revision returned by a read operation.",
].join(" ");

const selectedInput = (schema: typeof glossaryOperationRequestSchemas.list) => schema
  .omit({ schemaVersion: true, selector: true })
  .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
  .strict();

export const GLOSSARY_PUBLIC_INPUT_SCHEMAS = {
  list_targets: glossaryOperationRequestSchemas.list_targets.omit({ schemaVersion: true }),
  list: selectedInput(glossaryOperationRequestSchemas.list),
  search: glossaryOperationRequestSchemas.search
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
  get: glossaryOperationRequestSchemas.get
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
  create: glossaryOperationRequestSchemas.create
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
  create_batch: glossaryOperationRequestSchemas.create_batch
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
  update: glossaryOperationRequestSchemas.update
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
  delete: glossaryOperationRequestSchemas.delete
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
  validate: glossaryOperationRequestSchemas.validate
    .omit({ schemaVersion: true, selector: true })
    .extend({ selector: glossaryCheckoutSelectorSchema.default({ kind: "primary" }) })
    .strict(),
} as const;

export const GLOSSARY_MCP_TOOL_DEFINITIONS = [
  { name: "glossary.list_targets", operation: "list_targets", description: "List glossary checkout targets authorized by the active Session." },
  { name: "glossary.list", operation: "list", description: "List canonical glossary entries in YAML order." },
  { name: "glossary.search", operation: "search", description: "Search canonical glossary entries without fuzzy matching." },
  { name: "glossary.get", operation: "get", description: "Resolve a term or alias to its canonical glossary entry." },
  { name: "glossary.create", operation: "create", description: "Create one glossary entry in explicit or proactive mode." },
  { name: "glossary.create_batch", operation: "create_batch", description: "Create an all-or-conflict batch of glossary entries." },
  { name: "glossary.update", operation: "update", description: "Update one glossary entry after an explicit user request." },
  { name: "glossary.delete", operation: "delete", description: "Delete one glossary entry after an explicit user request." },
  { name: "glossary.validate", operation: "validate", description: "Validate the current glossary file without modifying it." },
] as const satisfies ReadonlyArray<{
  name: string;
  operation: GlossaryRuntimeOperation;
  description: string;
}>;

async function invoke(
  operation: GlossaryRuntimeOperation,
  input: Record<string, unknown>,
  deps: GlossaryMcpRuntimeDeps,
) {
  const value = await callGlossaryRuntime({
    operation,
    path: GLOSSARY_RUNTIME_OPERATION_PATHS[operation],
    body: { schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION, ...input },
  }, { ...deps, adapter: "mcp" });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...("ok" in value && value.ok === false ? { isError: true } : {}),
  };
}

export function createWithMateGlossaryMcpServer(deps: GlossaryMcpRuntimeDeps = {}): McpServer {
  const server = new McpServer(
    { name: "withmate-glossary", version: "1.0.0" },
    { instructions: GLOSSARY_MCP_SERVER_INSTRUCTIONS },
  );
  const definitions = new Map(GLOSSARY_MCP_TOOL_DEFINITIONS.map((definition) => [definition.operation, definition]));

  server.registerTool("glossary.list_targets", {
    description: definitions.get("list_targets")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.list_targets,
  }, (input) => invoke("list_targets", input, deps));
  server.registerTool("glossary.list", {
    description: definitions.get("list")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.list,
  }, (input) => invoke("list", input, deps));
  server.registerTool("glossary.search", {
    description: definitions.get("search")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.search,
  }, (input) => invoke("search", input, deps));
  server.registerTool("glossary.get", {
    description: definitions.get("get")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.get,
  }, (input) => invoke("get", input, deps));
  server.registerTool("glossary.create", {
    description: definitions.get("create")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.create,
  }, (input) => invoke("create", input, deps));
  server.registerTool("glossary.create_batch", {
    description: definitions.get("create_batch")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.create_batch,
  }, (input) => invoke("create_batch", input, deps));
  server.registerTool("glossary.update", {
    description: definitions.get("update")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.update,
  }, (input) => invoke("update", input, deps));
  server.registerTool("glossary.delete", {
    description: definitions.get("delete")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.delete,
  }, (input) => invoke("delete", input, deps));
  server.registerTool("glossary.validate", {
    description: definitions.get("validate")!.description,
    inputSchema: GLOSSARY_PUBLIC_INPUT_SCHEMAS.validate,
  }, (input) => invoke("validate", input, deps));

  return server;
}

export async function startWithMateGlossaryMcpServer(deps: GlossaryMcpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateGlossaryMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
