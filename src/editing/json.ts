import {
  applyEdits,
  modify,
  parse,
  type ParseError,
  type JSONPath,
} from "jsonc-parser";

import { ConfigKitError } from "../errors.js";

export function parseJsonText(text: string, path: string): unknown {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `Unable to parse ${path} without losing formatting`,
      phase: "parse",
      path,
      details: { errors: errors.map((error) => error.error) },
    });
  }
  return value;
}

export function asJsonObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `${path} must contain a JSON object`,
      phase: "parse",
      path,
    });
  }
  return value as Record<string, unknown>;
}

export function setJsonPath(
  text: string,
  path: JSONPath,
  value: unknown,
): string {
  const base = text.trim() === "" ? "{}\n" : text;
  const edits = modify(base, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return ensureTrailingNewline(applyEdits(base, edits));
}

export function deleteJsonPath(text: string, path: JSONPath): string {
  const base = text.trim() === "" ? "{}\n" : text;
  const edits = modify(base, path, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return ensureTrailingNewline(applyEdits(base, edits));
}

export function getJsonPath(value: unknown, path: JSONPath): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

export function createJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}