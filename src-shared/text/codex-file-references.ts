import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Code, Extension, State, Tokenizer } from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    fileReference: "fileReference";
  }
}

const visualizePrefix = "visualize";
const citationPrefix = ":codex-file-citation{";

function isLocalPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f\ud800-\udfff\ufffd]/u.test(value)) return false;
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "file:" && !/[\u0000-\u001f\u007f]/u.test(decodeURIComponent(url.pathname));
    } catch {
      return false;
    }
  }
  return /^\/(?!\/)/u.test(value)
    || /^[a-z]:[\\/]/iu.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
}

function citationAttributes(source: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let offset = 0;
  while (offset < source.length) {
    const match = /^\s*([a-z_]+)="/u.exec(source.slice(offset));
    if (!match || attributes.has(match[1])) return null;
    offset += match[0].length;
    let value = "";
    const decodeBackslash = match[1] !== "path"
      || /^[a-z]:\\\\/iu.test(source.slice(offset))
      || /^\\\\\\\\/u.test(source.slice(offset));
    let closed = false;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        closed = true;
        break;
      }
      if (char === "\\" && ((decodeBackslash && source[offset] === "\\") || source[offset] === '"')) {
        value += source[offset++];
      } else {
        value += char;
      }
    }
    if (!closed) return null;
    attributes.set(match[1], value);
    if (offset < source.length && !/\s/u.test(source[offset])) return null;
    if (!source.slice(offset).trim()) break;
  }
  return attributes;
}

function referencePath(source: string): string | null {
  if (source.startsWith(visualizePrefix)) {
    try {
      const value: unknown = JSON.parse(source.slice(visualizePrefix.length, -1));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const object = value as Record<string, unknown>;
      return isLocalPath(object.path)
        && (object.mode === undefined || object.mode === "wide")
        && (object.title === undefined || typeof object.title === "string")
        ? object.path : null;
    } catch {
      return null;
    }
  }
  const attributes = citationAttributes(source.slice(citationPrefix.length, -1));
  const path = attributes?.get("path");
  return isLocalPath(path) && attributes?.get("mode") !== "live" ? path : null;
}

const tokenizeReference: Tokenizer = function (effects, ok, nok) {
  const context = this;
  let prefix: string;
  let index = 0;
  let quoted = false;
  let escaped = false;
  let token: ReturnType<typeof effects.enter>;
  return start;

  function start(code: Code): ReturnType<State> {
    prefix = code === 58 ? citationPrefix : visualizePrefix;
    token = effects.enter("fileReference");
    return opening(code);
  }

  function opening(code: Code): ReturnType<State> {
    if (code !== prefix.charCodeAt(index)) return nok(code);
    effects.consume(code);
    index++;
    return index === prefix.length ? body : opening;
  }

  function body(code: Code): ReturnType<State> {
    if (code === null || code < 0 || code === 10 || code === 13) return nok(code);
    if (prefix === citationPrefix) {
      if (!escaped && code === 34) quoted = !quoted;
      if (code === 92 && !escaped) escaped = true;
      else escaped = false;
    }
    effects.consume(code);
    if ((prefix === visualizePrefix && code === 0xe201)
      || (prefix === citationPrefix && code === 125 && !quoted)) {
      effects.exit("fileReference");
      return referencePath(context.sliceSerialize(token)) === null ? nok : ok;
    }
    return body;
  }
};

export function codexFileReferencesSyntax(): Extension {
  return { text: { 58: { tokenize: tokenizeReference }, 0xe200: { tokenize: tokenizeReference } } };
}

export function codexFileReferencesFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      fileReference(token) {
        if (this.stack.some((node) => (
          node.type === "link" || node.type === "linkReference"
          || node.type === "image" || node.type === "imageReference"
        ))) {
          this.enter({ type: "text", value: this.sliceSerialize(token) }, token);
          return;
        }
        const source = this.sliceSerialize(token);
        const path = referencePath(source);
        if (path !== null) {
          const url = /^file:/iu.test(path) ? path : encodeURI(path).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
          const pathname = /^file:/iu.test(path) ? new URL(path).pathname : path;
          this.enter({ type: "link", url, children: [{ type: "text", value: path }],
            ...(source.startsWith(visualizePrefix) && /\.pdf$/iu.test(pathname)
              ? { data: { hProperties: { "data-codex-visualize-pdf": path } } } : {}),
          }, token);
        }
      },
    },
    exit: {
      fileReference(token) {
        this.exit(token);
      },
    },
  };
}
