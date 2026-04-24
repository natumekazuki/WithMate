import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CustomAgentConfig } from "@github/copilot-sdk";

import type { DiscoveredCustomAgent, DiscoveredCustomAgentSource } from "../src/app-state.js";

type CustomAgentRoot = {
  rootPath: string;
  source: DiscoveredCustomAgentSource;
  sourceLabel: string;
};

type CachedCustomAgentRoot = {
  fingerprint: string;
  agents: ResolvedCustomAgent[];
};

type CachedCustomAgentDiscovery = {
  fingerprint: string;
  agents: ResolvedCustomAgent[];
};

type ResolvedCustomAgent = DiscoveredCustomAgent & {
  prompt: string;
  tools?: string[] | null;
  userInvocable: boolean;
};

const customAgentRootCache = new Map<string, CachedCustomAgentRoot>();
const customAgentDiscoveryCache = new Map<string, CachedCustomAgentDiscovery>();

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function buildCustomAgentRoots(workspacePath: string, homeDirectory: string): CustomAgentRoot[] {
  return [
    {
      rootPath: path.join(workspacePath, ".github", "agents"),
      source: "workspace",
      sourceLabel: "workspace:.github/agents",
    },
    {
      rootPath: path.join(homeDirectory, ".copilot", "agents"),
      source: "global",
      sourceLabel: "global:~/.copilot/agents",
    },
  ];
}

function parseFrontmatterValue(frontmatter: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(frontmatter);
  if (!match) {
    return "";
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function parseFrontmatterBoolean(frontmatter: string, key: string): boolean | null {
  const rawValue = parseFrontmatterValue(frontmatter, key).toLowerCase();
  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  return null;
}

function parseFrontmatterTools(frontmatter: string): string[] | null | undefined {
  const inlineMatch = /^tools:\s*(.+)$/mi.exec(frontmatter);
  if (inlineMatch) {
    const rawValue = inlineMatch[1]?.trim() ?? "";
    if (!rawValue) {
      return undefined;
    }

    if (/^(all|null)$/i.test(rawValue)) {
      return null;
    }

    const arrayMatch = /^\[(.*)\]$/.exec(rawValue);
    if (arrayMatch) {
      return arrayMatch[1]
        .split(",")
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }

    return rawValue
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }

  const lines = frontmatter.split(/\r?\n/);
  const toolsIndex = lines.findIndex((line) => /^tools:\s*$/i.test(line.trim()));
  if (toolsIndex < 0) {
    return undefined;
  }

  const tools: string[] = [];
  for (let index = toolsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s*-\s+/.test(line)) {
      break;
    }

    tools.push(line.replace(/^\s*-\s+/, "").trim().replace(/^['"]|['"]$/g, ""));
  }

  return tools.length > 0 ? tools : undefined;
}

function parseCustomAgentMarkdown(
  agentFilePath: string,
): { name: string; displayName: string; description: string; prompt: string; tools?: string[] | null; userInvocable: boolean } {
  const markdown = fs.readFileSync(agentFilePath, "utf8");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const prompt = (frontmatterMatch ? markdown.slice(frontmatterMatch[0].length) : markdown).trim();

  return {
    name: parseFrontmatterValue(frontmatter, "name"),
    displayName:
      parseFrontmatterValue(frontmatter, "displayName")
      || parseFrontmatterValue(frontmatter, "display_name"),
    description: parseFrontmatterValue(frontmatter, "description"),
    prompt,
    tools: parseFrontmatterTools(frontmatter),
    userInvocable: parseFrontmatterBoolean(frontmatter, "user-invocable") === true,
  };
}

async function parseCustomAgentMarkdownAsync(
  agentFilePath: string,
): Promise<{ name: string; displayName: string; description: string; prompt: string; tools?: string[] | null; userInvocable: boolean }> {
  const markdown = await fs.promises.readFile(agentFilePath, "utf8");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const prompt = (frontmatterMatch ? markdown.slice(frontmatterMatch[0].length) : markdown).trim();

  return {
    name: parseFrontmatterValue(frontmatter, "name"),
    displayName:
      parseFrontmatterValue(frontmatter, "displayName")
      || parseFrontmatterValue(frontmatter, "display_name"),
    description: parseFrontmatterValue(frontmatter, "description"),
    prompt,
    tools: parseFrontmatterTools(frontmatter),
    userInvocable: parseFrontmatterBoolean(frontmatter, "user-invocable") === true,
  };
}

function toDisplayPath(workspacePath: string, source: DiscoveredCustomAgentSource, agentFilePath: string): string {
  if (source !== "workspace") {
    return normalizeSlashes(agentFilePath);
  }

  const relativePath = path.relative(workspacePath, agentFilePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return normalizeSlashes(agentFilePath);
  }

  return normalizeSlashes(relativePath);
}

function getCustomAgentRootCacheKey(root: CustomAgentRoot): string {
  return `${root.source}:${root.sourceLabel}:${normalizeSlashes(path.resolve(root.rootPath))}`;
}

function getCustomAgentDiscoveryCacheKey(workspacePath: string, homeDirectory: string): string {
  return [
    normalizeSlashes(path.resolve(workspacePath)),
    normalizeSlashes(path.resolve(homeDirectory)),
  ].join("|");
}

function statFileIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

async function statFileIfExistsAsync(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

function buildCustomAgentRootFingerprint(rootPath: string): string {
  const rootStats = statFileIfExists(rootPath);
  if (!rootStats?.isDirectory()) {
    return "missing";
  }

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const entryFingerprints = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".agent.md"))
    .map((entry) => {
      const agentFilePath = path.join(rootPath, entry.name);
      const agentFileStats = statFileIfExists(agentFilePath);
      return agentFileStats?.isFile()
        ? `${entry.name}:${agentFileStats.mtimeMs}:${agentFileStats.size}`
        : `${entry.name}:missing`;
    })
    .sort();

  return [
    rootStats.mtimeMs,
    rootStats.size,
    ...entryFingerprints,
  ].join("|");
}

async function buildCustomAgentRootFingerprintAsync(rootPath: string): Promise<string> {
  const rootStats = await statFileIfExistsAsync(rootPath);
  if (!rootStats?.isDirectory()) {
    return "missing";
  }

  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const entryFingerprints = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".agent.md"))
    .map(async (entry) => {
      const agentFilePath = path.join(rootPath, entry.name);
      const agentFileStats = await statFileIfExistsAsync(agentFilePath);
      return agentFileStats?.isFile()
        ? `${entry.name}:${agentFileStats.mtimeMs}:${agentFileStats.size}`
        : `${entry.name}:missing`;
    }));

  return [
    rootStats.mtimeMs,
    rootStats.size,
    ...entryFingerprints.sort(),
  ].join("|");
}

function cloneResolvedCustomAgents(agents: ResolvedCustomAgent[]): ResolvedCustomAgent[] {
  return agents.map((agent) => ({
    ...agent,
    tools: Array.isArray(agent.tools) ? [...agent.tools] : agent.tools,
  }));
}

function discoverCustomAgentsInRoot(workspacePath: string, root: CustomAgentRoot): ResolvedCustomAgent[] {
  if (!root.rootPath || !fs.existsSync(root.rootPath) || !fs.statSync(root.rootPath).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(root.rootPath, { withFileTypes: true });
  const discovered: ResolvedCustomAgent[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".agent.md")) {
      continue;
    }

    const agentFilePath = path.join(root.rootPath, entry.name);
    const parsed = parseCustomAgentMarkdown(agentFilePath);
    const fallbackName = entry.name.replace(/\.agent\.md$/i, "");
    const name = (parsed.name || fallbackName).trim();
    const prompt = parsed.prompt.trim();
    if (!name || !prompt) {
      continue;
    }

    discovered.push({
      id: `${root.source}:${normalizeSlashes(agentFilePath)}`,
      name,
      displayName: (parsed.displayName || name).trim(),
      description: parsed.description.trim(),
      source: root.source,
      sourcePath: toDisplayPath(workspacePath, root.source, agentFilePath),
      sourceLabel: root.sourceLabel,
      prompt,
      tools: parsed.tools,
      userInvocable: parsed.userInvocable,
    });
  }

  return discovered;
}

async function discoverCustomAgentsInRootAsync(workspacePath: string, root: CustomAgentRoot): Promise<ResolvedCustomAgent[]> {
  const rootStats = root.rootPath ? await statFileIfExistsAsync(root.rootPath) : null;
  if (!rootStats?.isDirectory()) {
    return [];
  }

  const entries = await fs.promises.readdir(root.rootPath, { withFileTypes: true });
  const discovered: ResolvedCustomAgent[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".agent.md")) {
      continue;
    }

    const agentFilePath = path.join(root.rootPath, entry.name);
    const parsed = await parseCustomAgentMarkdownAsync(agentFilePath);
    const fallbackName = entry.name.replace(/\.agent\.md$/i, "");
    const name = (parsed.name || fallbackName).trim();
    const prompt = parsed.prompt.trim();
    if (!name || !prompt) {
      continue;
    }

    discovered.push({
      id: `${root.source}:${normalizeSlashes(agentFilePath)}`,
      name,
      displayName: (parsed.displayName || name).trim(),
      description: parsed.description.trim(),
      source: root.source,
      sourcePath: toDisplayPath(workspacePath, root.source, agentFilePath),
      sourceLabel: root.sourceLabel,
      prompt,
      tools: parsed.tools,
      userInvocable: parsed.userInvocable,
    });
  }

  return discovered;
}

function discoverCustomAgentsInRootCached(
  workspacePath: string,
  root: CustomAgentRoot,
): { fingerprint: string; agents: ResolvedCustomAgent[] } {
  const fingerprint = buildCustomAgentRootFingerprint(root.rootPath);
  const cacheKey = getCustomAgentRootCacheKey(root);
  const cached = customAgentRootCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return {
      fingerprint,
      agents: cloneResolvedCustomAgents(cached.agents),
    };
  }

  const agents = discoverCustomAgentsInRoot(workspacePath, root);
  customAgentRootCache.set(cacheKey, {
    fingerprint,
    agents: cloneResolvedCustomAgents(agents),
  });

  return {
    fingerprint,
    agents,
  };
}

async function discoverCustomAgentsInRootCachedAsync(
  workspacePath: string,
  root: CustomAgentRoot,
): Promise<{ fingerprint: string; agents: ResolvedCustomAgent[] }> {
  const fingerprint = await buildCustomAgentRootFingerprintAsync(root.rootPath);
  const cacheKey = getCustomAgentRootCacheKey(root);
  const cached = customAgentRootCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return {
      fingerprint,
      agents: cloneResolvedCustomAgents(cached.agents),
    };
  }

  const agents = await discoverCustomAgentsInRootAsync(workspacePath, root);
  customAgentRootCache.set(cacheKey, {
    fingerprint,
    agents: cloneResolvedCustomAgents(agents),
  });

  return {
    fingerprint,
    agents,
  };
}

function dedupeCustomAgents(discovered: ResolvedCustomAgent[]): ResolvedCustomAgent[] {
  const deduped = new Map<string, ResolvedCustomAgent>();

  for (const agent of discovered) {
    const normalizedName = agent.name.trim().toLowerCase();
    const existing = deduped.get(normalizedName);
    if (!existing) {
      deduped.set(normalizedName, agent);
      continue;
    }

    if (existing.source === "global" && agent.source === "workspace") {
      deduped.set(normalizedName, agent);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === "workspace" ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

function resolveCustomAgents(workspacePath: string, homeDirectory: string): ResolvedCustomAgent[] {
  const roots = buildCustomAgentRoots(workspacePath, homeDirectory);
  const rootResults = roots.map((root) => discoverCustomAgentsInRootCached(workspacePath, root));
  const fingerprint = rootResults.map((result) => result.fingerprint).join("||");
  const cacheKey = getCustomAgentDiscoveryCacheKey(workspacePath, homeDirectory);
  const cached = customAgentDiscoveryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return cloneResolvedCustomAgents(cached.agents);
  }

  const agents = dedupeCustomAgents(rootResults.flatMap((result) => result.agents));
  customAgentDiscoveryCache.set(cacheKey, {
    fingerprint,
    agents: cloneResolvedCustomAgents(agents),
  });

  return agents;
}

async function resolveCustomAgentsAsync(workspacePath: string, homeDirectory: string): Promise<ResolvedCustomAgent[]> {
  const roots = buildCustomAgentRoots(workspacePath, homeDirectory);
  const rootResults = await Promise.all(roots.map((root) => discoverCustomAgentsInRootCachedAsync(workspacePath, root)));
  const fingerprint = rootResults.map((result) => result.fingerprint).join("||");
  const cacheKey = getCustomAgentDiscoveryCacheKey(workspacePath, homeDirectory);
  const cached = customAgentDiscoveryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return cloneResolvedCustomAgents(cached.agents);
  }

  const agents = dedupeCustomAgents(rootResults.flatMap((result) => result.agents));
  customAgentDiscoveryCache.set(cacheKey, {
    fingerprint,
    agents: cloneResolvedCustomAgents(agents),
  });

  return agents;
}

export async function discoverSessionCustomAgents(
  workspacePath: string,
  homeDirectory: string = os.homedir(),
): Promise<DiscoveredCustomAgent[]> {
  return (await resolveCustomAgentsAsync(workspacePath, homeDirectory))
    .filter((agent) => agent.userInvocable)
    .map(({ prompt: _prompt, tools: _tools, userInvocable: _userInvocable, ...agent }) => agent);
}

export function resolveSessionCustomAgentConfigs(
  workspacePath: string,
  selectedAgentName: string,
  homeDirectory: string = os.homedir(),
): { customAgents: CustomAgentConfig[]; selectedAgentName: string | null } {
  const resolvedAgents = resolveCustomAgents(workspacePath, homeDirectory);
  const customAgents: CustomAgentConfig[] = resolvedAgents.map((agent) => ({
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description || undefined,
    prompt: agent.prompt,
    tools: agent.tools,
  }));
  const normalizedSelectedAgentName = selectedAgentName.trim().toLowerCase();
  const selectedAgent = normalizedSelectedAgentName
    ? resolvedAgents.find((agent) => agent.name.trim().toLowerCase() === normalizedSelectedAgentName) ?? null
    : null;

  return {
    customAgents,
    selectedAgentName: selectedAgent?.name ?? null,
  };
}
