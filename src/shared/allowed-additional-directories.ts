import path from "node:path";

import { normalizeHostAbsolutePath } from "./workspace-path.js";

export const ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS = {
  maxItems: 1_024,
  maxPathLength: 32_768,
  maxJsonBytes: 4 * 1_024 * 1_024,
} as const;

export type CanonicalAllowedAdditionalDirectory = Readonly<{
  path: string;
  comparisonKey: string;
}>;

export function canonicalizeAllowedAdditionalDirectories(
  directories: readonly string[],
): readonly CanonicalAllowedAdditionalDirectory[] | undefined {
  const canonical = directories.map((value) => normalizeHostAbsolutePath(value));
  return canonical.some((value) => value === undefined)
    ? undefined
    : (canonical as readonly CanonicalAllowedAdditionalDirectory[]);
}

export function compactCanonicalAllowedAdditionalDirectories(
  directories: readonly CanonicalAllowedAdditionalDirectory[],
): readonly string[] {
  const candidates = [...directories];
  candidates.sort(
    (left, right) =>
      left.comparisonKey.length - right.comparisonKey.length || left.comparisonKey.localeCompare(right.comparisonKey),
  );
  const retained: CanonicalAllowedAdditionalDirectory[] = [];
  const root: DirectoryPrefixNode = { children: new Map() };
  for (const candidate of candidates) {
    if (!retainDirectory(root, candidate.comparisonKey)) continue;
    retained.push(candidate);
  }
  return retained.map(({ path: value }) => value);
}

export function normalizeAllowedAdditionalDirectories(directories: readonly string[]): readonly string[] | undefined {
  const canonical = canonicalizeAllowedAdditionalDirectories(directories);
  return canonical === undefined ? undefined : compactCanonicalAllowedAdditionalDirectories(canonical);
}

export function allowedAdditionalDirectoriesJsonByteLength(directories: readonly string[]): number {
  return Buffer.byteLength(JSON.stringify(directories));
}

type DirectoryPrefixNode = {
  terminal?: true;
  children: Map<string, DirectoryPrefixEdge>;
};

type DirectoryPrefixEdge = {
  label: string;
  node: DirectoryPrefixNode;
};

function retainDirectory(root: DirectoryPrefixNode, value: string): boolean {
  let node = root;
  let offset = 0;
  while (true) {
    if (
      node.terminal === true &&
      (offset === value.length || value[offset] === path.sep || value[offset - 1] === path.sep)
    ) {
      return false;
    }
    if (offset === value.length) {
      node.terminal = true;
      return true;
    }
    const firstCharacter = value[offset] as string;
    const edge = node.children.get(firstCharacter);
    if (edge === undefined) {
      node.children.set(firstCharacter, {
        label: value.slice(offset),
        node: { terminal: true, children: new Map() },
      });
      return true;
    }
    const commonLength = commonPrefixLength(edge.label, value, offset);
    if (commonLength === edge.label.length) {
      offset += commonLength;
      node = edge.node;
      continue;
    }

    const branch: DirectoryPrefixNode = { children: new Map() };
    const existingSuffix = edge.label.slice(commonLength);
    branch.children.set(existingSuffix[0] as string, { label: existingSuffix, node: edge.node });
    const sharedPrefix = edge.label.slice(0, commonLength);
    node.children.set(sharedPrefix[0] as string, { label: sharedPrefix, node: branch });
    offset += commonLength;
    if (offset === value.length) {
      branch.terminal = true;
    } else {
      const newSuffix = value.slice(offset);
      branch.children.set(newSuffix[0] as string, {
        label: newSuffix,
        node: { terminal: true, children: new Map() },
      });
    }
    return true;
  }
}

function commonPrefixLength(edge: string, value: string, valueOffset: number): number {
  const maxLength = Math.min(edge.length, value.length - valueOffset);
  let length = 0;
  while (length < maxLength && edge[length] === value[valueOffset + length]) {
    length += 1;
  }
  return length;
}
