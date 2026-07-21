import { CodexWireProtocolError } from "./wire-envelope.js";

type ObjectFrame = {
  kind: "object";
  state: "keyOrEnd" | "colon" | "value" | "commaOrEnd";
  keys: Set<string>;
};

type ArrayFrame = {
  kind: "array";
  state: "valueOrEnd" | "commaOrEnd";
};

type JsonFrame = ObjectFrame | ArrayFrame;

export function parseStrictJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CodexWireProtocolError("malformed_json");
  }
  rejectDuplicateObjectKeys(text);
  return value;
}

function rejectDuplicateObjectKeys(text: string): void {
  const frames: JsonFrame[] = [];
  let rootState: "value" | "done" = "value";
  let offset = 0;

  while (offset < text.length) {
    offset = skipWhitespace(text, offset);
    if (offset >= text.length) return;

    const frame = frames.at(-1);
    if (frame === undefined) {
      if (rootState === "done") return;
      rootState = "done";
      const nextOffset = consumeValue(text, offset, frames);
      if (nextOffset === undefined) return;
      offset = nextOffset;
      continue;
    }

    if (frame.kind === "array") {
      if (frame.state === "valueOrEnd") {
        if (text[offset] === "]") {
          frames.pop();
          offset += 1;
          continue;
        }
        frame.state = "commaOrEnd";
        const nextOffset = consumeValue(text, offset, frames);
        if (nextOffset === undefined) return;
        offset = nextOffset;
        continue;
      }
      if (text[offset] === ",") {
        frame.state = "valueOrEnd";
        offset += 1;
        continue;
      }
      if (text[offset] === "]") {
        frames.pop();
        offset += 1;
        continue;
      }
      return;
    }

    switch (frame.state) {
      case "keyOrEnd": {
        if (text[offset] === "}") {
          frames.pop();
          offset += 1;
          break;
        }
        const key = readJsonString(text, offset);
        if (key === undefined) return;
        if (frame.keys.has(key.value)) {
          throw new CodexWireProtocolError("invalid_envelope");
        }
        frame.keys.add(key.value);
        frame.state = "colon";
        offset = key.end;
        break;
      }
      case "colon":
        if (text[offset] !== ":") return;
        frame.state = "value";
        offset += 1;
        break;
      case "value": {
        frame.state = "commaOrEnd";
        const nextOffset = consumeValue(text, offset, frames);
        if (nextOffset === undefined) return;
        offset = nextOffset;
        break;
      }
      case "commaOrEnd":
        if (text[offset] === ",") {
          frame.state = "keyOrEnd";
          offset += 1;
          break;
        }
        if (text[offset] === "}") {
          frames.pop();
          offset += 1;
          break;
        }
        return;
    }
  }
}

function consumeValue(text: string, offset: number, frames: JsonFrame[]): number | undefined {
  const character = text[offset];
  if (character === "{") {
    frames.push({ kind: "object", state: "keyOrEnd", keys: new Set() });
    return offset + 1;
  }
  if (character === "[") {
    frames.push({ kind: "array", state: "valueOrEnd" });
    return offset + 1;
  }
  if (character === '"') {
    return readJsonString(text, offset)?.end;
  }

  let end = offset;
  while (end < text.length && !isValueDelimiter(text[end] as string)) end += 1;
  return end === offset ? undefined : end;
}

function readJsonString(text: string, offset: number): Readonly<{ value: string; end: number }> | undefined {
  if (text[offset] !== '"') return undefined;
  for (let index = offset + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] !== '"') continue;
    const token = text.slice(offset, index + 1);
    try {
      const value = JSON.parse(token) as unknown;
      return typeof value === "string" ? { value, end: index + 1 } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function skipWhitespace(text: string, offset: number): number {
  while (offset < text.length && /\s/u.test(text[offset] as string)) offset += 1;
  return offset;
}

function isValueDelimiter(character: string): boolean {
  return character === "," || character === "]" || character === "}" || /\s/u.test(character);
}
