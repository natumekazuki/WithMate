import { randomUUID } from "node:crypto";
import type { LiveElicitationField, LiveElicitationRequest, LiveElicitationResponse } from "../../../src-shared/session/runtime-state.js";
import type { RunSessionTurnInput } from "../provider-runtime.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";

export type CodexInteractionRequest = {
  id: string | number;
  method: string;
  params: unknown;
  respond(result: unknown): Promise<void>;
  reject(error: { code: number; message: string; data?: unknown }): Promise<void>;
};

type InteractionInput = Pick<RunSessionTurnInput, "onApprovalRequest" | "onElicitationRequest" | "signal">;
type PendingRequest = { request: CodexInteractionRequest; controller: AbortController; responded: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function abortRace<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Interaction canceled"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function validField(field: LiveElicitationField, value: unknown): boolean {
  if (value === undefined) return !field.required;
  switch (field.type) {
    case "text": {
      if (typeof value !== "string" || (field.required && !value.trim())) return false;
      const length = [...value].length;
      if ((field.minLength !== undefined && length < field.minLength) || (field.maxLength !== undefined && length > field.maxLength)) return false;
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
      if (field.format === "uri") { try { new URL(value); } catch { return false; } }
      if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) return false;
      if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))) return false;
      return true;
    }
    case "select": return typeof value === "string" && Boolean(value.trim()) && (field.allowFreeText === true || field.options.some((option) => option.value === value));
    case "multi-select": return strings(value) && new Set(value).size === value.length && (!field.required || value.length > 0)
      && (field.minItems === undefined || value.length >= field.minItems) && (field.maxItems === undefined || value.length <= field.maxItems)
      && value.every((item) => Boolean(item.trim()) && (field.allowFreeText === true || field.options.some((option) => option.value === item)));
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value) && (field.numberKind !== "integer" || Number.isInteger(value))
      && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
  }
}

function validContent(fields: LiveElicitationField[], response: LiveElicitationResponse): boolean {
  const content = response.content ?? {};
  return record(content) && Object.keys(content).every((name) => fields.some((field) => field.name === name))
    && fields.every((field) => validField(field, Object.hasOwn(content, field.name) ? content[field.name] : undefined));
}

function questions(params: Record<string, unknown>, requestId: string): LiveElicitationRequest | null {
  if (typeof params.isBlocking !== "boolean" || !Array.isArray(params.questions) || params.questions.length === 0) return null;
  const fields: LiveElicitationField[] = [];
  for (const question of params.questions) {
    if (!record(question) || !text(question.id) || !text(question.question) || !text(question.header)
      || typeof question.isSecret !== "boolean" || typeof question.isOther !== "boolean" || fields.some((field) => field.name === question.id)) return null;
    const base = { name: text(question.id), title: text(question.header), description: text(question.question), required: true };
    if (question.options === null || question.options === undefined) {
      fields.push({ ...base, type: "text", secret: question.isSecret });
      continue;
    }
    if (!Array.isArray(question.options)) return null;
    const options: { value: string; label: string }[] = [];
    for (const option of question.options) {
      if (!record(option) || !text(option.label) || typeof option.description !== "string" || options.some((entry) => entry.value === option.label)) return null;
      options.push({ value: text(option.label), label: text(option.description) ? `${text(option.label)} — ${text(option.description)}` : text(option.label) });
    }
    if (options.length === 0 && !question.isOther) return null;
    fields.push(question.isSecret ? { ...base, type: "text", secret: true } : { ...base, type: "select", options, allowFreeText: question.isOther });
  }
  return { requestId, provider: "codex", mode: "form", message: "Codex has a question", fields, blocking: params.isBlocking };
}

// Projection is deliberately limited to constraints represented by the existing form UI.
function mcpField(name: string, schema: unknown, required: boolean): LiveElicitationField | null {
  if (!record(schema)) return null;
  const keys = ["type", "title", "description", "default"];
  if (schema.type === "string") keys.push("enum", "enumNames", "oneOf", "minLength", "maxLength", "format");
  else if (schema.type === "array") keys.push("items", "minItems", "maxItems");
  else if (schema.type === "number" || schema.type === "integer") keys.push("minimum", "maximum");
  else if (schema.type !== "boolean") return null;
  if (!onlyKeys(schema, keys)) return null;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isInteger(schema[key]) || schema[key] < 0)) return null;
  }
  for (const key of ["minimum", "maximum"]) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) return null;
  if (schema.format !== undefined && !["email", "uri", "date", "date-time"].includes(text(schema.format))) return null;
  if (schema.enum !== undefined && (!strings(schema.enum) || schema.enum.length === 0)) return null;
  if (schema.enumNames !== undefined && (!strings(schema.enumNames) || !strings(schema.enum) || schema.enumNames.length !== schema.enum.length)) return null;
  if (schema.enum !== undefined && schema.oneOf !== undefined) return null;
  if (schema.oneOf !== undefined && (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0 || !schema.oneOf.every((option) => record(option) && onlyKeys(option, ["const", "title"]) && typeof option.const === "string" && typeof option.title === "string"))) return null;
  if (schema.type === "array") {
    if (!record(schema.items) || !onlyKeys(schema.items, ["type", "enum", "anyOf"]) || (schema.items.type !== undefined && schema.items.type !== "string")) return null;
    if (schema.items.enum !== undefined && (!strings(schema.items.enum) || schema.items.enum.length === 0)) return null;
    if (schema.items.enum !== undefined && schema.items.anyOf !== undefined) return null;
    if (schema.items.anyOf !== undefined && (!Array.isArray(schema.items.anyOf) || schema.items.anyOf.length === 0 || !schema.items.anyOf.every((option) => record(option) && onlyKeys(option, ["const", "title"]) && typeof option.const === "string" && typeof option.title === "string"))) return null;
  }
  if ((schema.enum !== undefined || schema.oneOf !== undefined) && (schema.minLength !== undefined || schema.maxLength !== undefined || schema.format !== undefined)) return null;
  return buildLiveElicitationFieldFromMcpSchema(name, schema, required);
}

function mcp(params: Record<string, unknown>, requestId: string): LiveElicitationRequest | null {
  if (!text(params.message) || !text(params.serverName)) return null;
  const base = { requestId, provider: "codex", message: text(params.message), source: text(params.serverName) };
  if (params.mode === "url") {
    try { const url = new URL(text(params.url)); if (!["https:", "http:"].includes(url.protocol)) return null; } catch { return null; }
    return { ...base, mode: "url", fields: [], url: text(params.url) };
  }
  if (!["form", "openai/form", "openaiForm"].includes(text(params.mode))) return null;
  const schema = params.requestedSchema;
  if (!record(schema) || !onlyKeys(schema, ["$schema", "type", "properties", "required", "additionalProperties"]) || schema.type !== "object" || !record(schema.properties)
    || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    || (schema.required !== undefined && !strings(schema.required))) return null;
  const required = new Set(strings(schema.required) ? schema.required : []);
  if ([...required].some((name) => !Object.hasOwn(schema.properties as object, name))) return null;
  const fields: LiveElicitationField[] = [];
  for (const [name, value] of Object.entries(schema.properties)) {
    const field = mcpField(name, value, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return { ...base, mode: "form", fields };
}

function permissionSubset(value: unknown): Record<string, unknown> | null {
  if (!record(value) || !onlyKeys(value, ["network", "fileSystem"])) return null;
  const result: Record<string, unknown> = {};
  if (value.network !== null && value.network !== undefined) {
    if (!record(value.network) || !onlyKeys(value.network, ["enabled"]) || (value.network.enabled !== null && typeof value.network.enabled !== "boolean")) return null;
    result.network = value.network;
  }
  if (value.fileSystem !== null && value.fileSystem !== undefined) {
    const fs = value.fileSystem;
    if (!record(fs) || !onlyKeys(fs, ["read", "write", "entries", "globScanMaxDepth"])) return null;
    for (const key of ["read", "write"]) if (fs[key] !== undefined && fs[key] !== null && !strings(fs[key])) return null;
    if (fs.globScanMaxDepth !== undefined && (typeof fs.globScanMaxDepth !== "number" || !Number.isInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 0)) return null;
    if (fs.entries !== undefined && (!Array.isArray(fs.entries) || !fs.entries.every((entry) => {
      if (!record(entry) || !onlyKeys(entry, ["path", "access"]) || !["read", "write", "deny"].includes(text(entry.access)) || !record(entry.path)) return false;
      const path = entry.path;
      return path.type === "path" ? onlyKeys(path, ["type", "path"]) && Boolean(text(path.path))
        : path.type === "glob_pattern" ? onlyKeys(path, ["type", "pattern"]) && Boolean(text(path.pattern))
          : path.type === "special" && onlyKeys(path, ["type", "value"]) && record(path.value)
            && (["root", "minimal", "tmpdir", "slash_tmp"].includes(text(path.value.kind)) ? onlyKeys(path.value, ["kind"])
              : path.value.kind === "project_roots" ? onlyKeys(path.value, ["kind", "subpath"]) && (path.value.subpath === null || typeof path.value.subpath === "string")
                : path.value.kind === "unknown" && onlyKeys(path.value, ["kind", "path", "subpath"]) && typeof path.value.path === "string" && (path.value.subpath === null || typeof path.value.subpath === "string"));
    }))) return null;
    result.fileSystem = fs;
  }
  return result;
}

export class CodexTurnInteractions {
  private readonly pending = new Map<string | number, PendingRequest>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly abort = () => this.close();

  constructor(private readonly input: InteractionInput, private readonly redact: (value: string) => string = (value) => value, private readonly onError: (error: unknown) => void = () => {}) {
    input.signal?.addEventListener("abort", this.abort, { once: true });
    if (input.signal?.aborted) this.close();
  }

  accept(request: CodexInteractionRequest): void {
    if (this.closed || this.pending.has(request.id)) return;
    const entry = { request, controller: new AbortController(), responded: false };
    this.pending.set(request.id, entry);
    this.tail = this.tail.then(async () => {
      if (entry.controller.signal.aborted || this.closed) return;
      try { await this.handle(entry); }
      catch (error) {
        if (!entry.controller.signal.aborted && !this.closed) {
          if (!entry.responded) {
            entry.responded = true;
            try { await request.reject({ code: -32602, message: "Codex interaction could not be answered" }); } catch (writeError) { this.onError(writeError); }
          }
          this.onError(error);
        }
      } finally {
        if (this.pending.get(request.id) === entry) this.pending.delete(request.id);
      }
    });
  }

  resolve(id: string | number): void {
    this.pending.get(id)?.controller.abort();
    this.pending.delete(id);
  }

  close(): void {
    this.closed = true;
    this.input.signal?.removeEventListener("abort", this.abort);
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
  }

  private async handle(entry: PendingRequest): Promise<void> {
    const { request, controller } = entry;
    const signal = controller.signal;
    const params = request.params;
    if (!record(params)) throw new Error("Invalid interaction parameters");
    const requestId = randomUUID();
    const reply = async (result: unknown) => {
      if (!signal.aborted && !this.closed && !entry.responded) { entry.responded = true; await request.respond(result); }
    };
    if (request.method === "mcpServer/elicitation/request" && record(params._meta) && params._meta.codex_approval_kind === "mcp_tool_call") {
      const projected = mcp(params, requestId);
      if (!projected || projected.mode !== "form" || projected.fields.length !== 0) throw new Error("Unsupported MCP tool approval");
      const decision = this.input.onApprovalRequest ? await abortRace(this.input.onApprovalRequest({ requestId, provider: "codex", kind: "mcp_tool_call",
        title: "Codex MCP tool approval", summary: this.redact(projected.message), details: this.redact(JSON.stringify(params._meta)), decisionMode: "direct-decision" }, signal), signal) : "deny";
      await reply({ action: decision === "approve" ? "accept" : "decline", content: decision === "approve" ? {} : null });
      return;
    }
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(request.method)) {
      const permissions = request.method === "item/permissions/requestApproval" ? permissionSubset(params.permissions) : undefined;
      if (permissions === null) throw new Error("Unsupported permissions");
      const available = params.availableDecisions;
      if (available !== undefined && available !== null && !Array.isArray(available)) throw new Error("Invalid approval decisions");
      const allowed = Array.isArray(available) ? available : ["accept", "decline", "cancel"];
      const canApprove = permissions !== undefined || allowed.includes("accept");
      let approve = false;
      if (canApprove && this.input.onApprovalRequest) {
        approve = await abortRace(this.input.onApprovalRequest({ requestId, provider: "codex", kind: request.method,
          title: "Codex approval", summary: this.redact(text(params.reason) || text(params.command) || request.method),
          details: this.redact(JSON.stringify(params)), decisionMode: "direct-decision" }, signal), signal) === "approve";
      }
      if (permissions !== undefined) { await reply({ permissions: approve ? permissions : {}, scope: "turn" }); return; }
      const decision = approve ? "accept" : allowed.includes("decline") ? "decline" : allowed.includes("cancel") ? "cancel" : null;
      if (!decision) throw new Error("No supported approval decision");
      await reply({ decision });
      return;
    }
    const native = request.method === "item/tool/requestUserInput";
    const projected = native ? questions(params, requestId) : request.method === "mcpServer/elicitation/request" ? mcp(params, requestId) : null;
    if (!projected) throw new Error("Unsupported interaction schema");
    if (!this.input.onElicitationRequest) {
      if (native) throw new Error("Question UI unavailable");
      await reply({ action: "decline", content: null });
      return;
    }
    const display: LiveElicitationRequest = { ...projected, message: this.redact(projected.message), source: projected.source ? this.redact(projected.source) : undefined,
      fields: projected.fields.map((field) => ({ ...field, title: this.redact(field.title), description: field.description ? this.redact(field.description) : undefined,
        ...((field.type === "select" || field.type === "multi-select") ? { options: field.options.map((option) => ({ ...option, label: this.redact(option.label) })) } : {}) })) };
    const response = await abortRace(this.input.onElicitationRequest(display, signal), signal);
    if (!["accept", "decline", "cancel"].includes(response.action)) throw new Error("Invalid interaction action");
    if (native) {
      if (response.action !== "accept") throw new Error("Question not answered");
      if (!validContent(projected.fields, response)) throw new Error("Invalid question answer");
      const answers: Record<string, { answers: string[] }> = Object.create(null);
      for (const question of params.questions as Record<string, unknown>[]) {
        const value = response.content?.[text(question.id)];
        if (typeof value !== "string" || (Array.isArray(question.options) && question.isOther !== true && !question.options.some((option) => record(option) && option.label === value))) throw new Error("Invalid question choice");
        answers[text(question.id)] = { answers: [value] };
      }
      await reply({ answers });
    } else {
      if (response.action === "accept" && !validContent(projected.fields, response)) throw new Error("Invalid MCP form content");
      await reply({ action: response.action, content: response.action === "accept" && projected.mode === "form" ? response.content ?? {} : null });
    }
  }
}
