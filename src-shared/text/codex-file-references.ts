import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Code, Extension, State, Tokenizer } from "micromark-util-types";

declare module "micromark-util-types" {
  /** 独自のファイル参照トークンをmicromarkの型一覧に登録する。 */
  interface TokenTypeMap {
    fileReference: "fileReference";
  }
}

const visualizePrefix = "visualize";
const citationPrefix = ":codex-file-citation{";

/** 制御文字を除外し、構文上ローカル参照として扱う絶対パスまたはfile URLかを判定する。 */
function isLocalPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    /[\u0000-\u001f\u007f\ud800-\udfff\ufffd]/u.test(value)
  )
    return false;
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "file:" &&
        !/[\u0000-\u001f\u007f]/u.test(decodeURIComponent(url.pathname))
      );
    } catch {
      return false;
    }
  }
  return (
    /^\/(?!\/)/u.test(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
  );
}

/** 引用の引用符付き属性を読み取る。重複、閉じ忘れ、区切り不正は受け付けない。 */
function citationAttributes(source: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let offset = 0;
  while (offset < source.length) {
    const match = /^\s*([a-z_]+)="/u.exec(source.slice(offset));
    if (!match || attributes.has(match[1])) return null;
    offset += match[0].length;
    let value = "";
    const decodeBackslash =
      match[1] !== "path" ||
      /^[a-z]:\\\\/iu.test(source.slice(offset)) ||
      /^\\\\\\\\/u.test(source.slice(offset));
    let closed = false;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        closed = true;
        break;
      }
      if (
        char === "\\" &&
        ((decodeBackslash && source[offset] === "\\") || source[offset] === '"')
      ) {
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

/** 解析されたローカル参照と、visualize形式の場合だけ保持する表示属性。 */
type FileReference = {
  path: string;
  visualize?: { title?: string; mode?: "wide" };
};

/** visualizeのJSONまたは引用属性を解釈し、無効なパスや非対応モードでは参照を作らない。 */
function reference(source: string): FileReference | null {
  if (source.startsWith(visualizePrefix)) {
    try {
      const value: unknown = JSON.parse(
        source.slice(visualizePrefix.length, -1),
      );
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
      const object = value as Record<string, unknown>;
      return isLocalPath(object.path) &&
        (object.mode === undefined || object.mode === "wide") &&
        (object.title === undefined || typeof object.title === "string")
        ? {
            path: object.path,
            visualize: {
              title: object.title as string | undefined,
              mode: object.mode as "wide" | undefined,
            },
          }
        : null;
    } catch {
      return null;
    }
  }
  const attributes = citationAttributes(
    source.slice(citationPrefix.length, -1),
  );
  const path = attributes?.get("path");
  return isLocalPath(path) && attributes?.get("mode") !== "live"
    ? { path }
    : null;
}

/** Markdown本文中の単一行参照をひとつのトークンとして取り出し、不完全なら通常の解析に戻す。 */
const tokenizeReference: Tokenizer = function (effects, ok, nok) {
  const context = this;
  let prefix: string;
  let index = 0;
  let quoted = false;
  let escaped = false;
  let token: ReturnType<typeof effects.enter>;
  return start;

  /** 開始文字から参照形式を選び、トークンの記録を開始する。 */
  function start(code: Code): ReturnType<State> {
    prefix = code === 58 ? citationPrefix : visualizePrefix;
    token = effects.enter("fileReference");
    return opening(code);
  }

  /** 接頭辞を一文字ずつ照合し、一致しなければこの参照候補を棄却する。 */
  function opening(code: Code): ReturnType<State> {
    if (code !== prefix.charCodeAt(index)) return nok(code);
    effects.consume(code);
    index++;
    return index === prefix.length ? body : opening;
  }

  /** 終端まで読み、引用属性の引用符内にある波括弧を終端と誤認しない。 */
  function body(code: Code): ReturnType<State> {
    if (code === null || code < 0 || code === 10 || code === 13)
      return nok(code);
    if (prefix === citationPrefix) {
      if (!escaped && code === 34) quoted = !quoted;
      if (code === 92 && !escaped) escaped = true;
      else escaped = false;
    }
    effects.consume(code);
    if (
      (prefix === visualizePrefix && code === 0xe201) ||
      (prefix === citationPrefix && code === 125 && !quoted)
    ) {
      effects.exit("fileReference");
      return reference(context.sliceSerialize(token)) === null ? nok : ok;
    }
    return body;
  }
};

/** Codexのファイル参照を認識する二つの接頭辞をmicromarkのテキスト構文に加える。 */
export function codexFileReferencesSyntax(): Extension {
  return {
    text: {
      58: { tokenize: tokenizeReference },
      0xe200: { tokenize: tokenizeReference },
    },
  };
}

/** 参照トークンからmdastのリンクまたはテキストを作る拡張を返す。 */
export function codexFileReferencesFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      /** 通常のリンクや画像の内側では二重にリンク化せず、外側では参照先と表示属性を組み立てる。 */
      fileReference(token) {
        if (
          this.stack.some(
            (node) =>
              node.type === "link" ||
              node.type === "linkReference" ||
              node.type === "image" ||
              node.type === "imageReference",
          )
        ) {
          this.enter(
            { type: "text", value: this.sliceSerialize(token) },
            token,
          );
          return;
        }
        const parsed = reference(this.sliceSerialize(token));
        if (parsed !== null) {
          const { path } = parsed;
          const url = /^file:/iu.test(path)
            ? path
            : encodeURI(path).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
          const displayPath =
            parsed.visualize && /^file:/iu.test(path)
              ? decodeURIComponent(new URL(path).pathname)
              : path;
          const label = parsed.visualize
            ? displayPath.split(/[\\/]/u).pop() || path
            : path;
          this.enter(
            {
              type: "link",
              url,
              children: [{ type: "text", value: label }],
              ...(parsed.visualize
                ? {
                    data: {
                      hProperties: {
                        "data-codex-visualize-path": path,
                        ...(parsed.visualize.title === undefined
                          ? {}
                          : {
                              "data-codex-visualize-title":
                                parsed.visualize.title,
                            }),
                        ...(parsed.visualize.mode === undefined
                          ? {}
                          : {
                              "data-codex-visualize-mode":
                                parsed.visualize.mode,
                            }),
                      },
                    },
                  }
                : {}),
            },
            token,
          );
        }
      },
    },
    exit: {
      /** 入場側で作ったmdastノードを対応するトークンの末尾で閉じる。 */
      fileReference(token) {
        this.exit(token);
      },
    },
  };
}
