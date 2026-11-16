import { parse } from "smol-toml";

import { ConfigKitError } from "../errors.js";

export type TomlScalar = string | number | boolean | string[];

interface Block {
  path: string[];
  headerIndex: number;
  endIndex: number;
}

const HEADER = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

export function parseTomlText(text: string, path: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  try {
    const value = parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("TOML root is not a table");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new ConfigKitError({
      code: "UNPARSEABLE_CONFIG",
      message: `Unable to parse ${path} without losing formatting`,
      phase: "parse",
      path,
      cause: error,
    });
  }
}

export function setTomlTable(
  text: string,
  tablePath: string[],
  entries: Record<string, TomlScalar>,
  path: string,
): string {
  assertBarePath(tablePath, path);
  const lines = toLines(text);
  const blocks = findBlocks(lines);
  const block = blocks.find((candidate) => samePath(candidate.path, tablePath));

  if (block === undefined) {
    ensureTrailingBlank(lines);
    lines.push(`[${tablePath.join(".")}]`);
    for (const [key, value] of Object.entries(entries)) {
      lines.push(`${key} = ${serializeTomlValue(value)}`);
    }
    lines.push("");
  } else {
    const contentEnd = findSubtableStart(lines, block, tablePath);
    for (const [key, value] of Object.entries(entries)) {
      const index = findKeyLine(lines, block, key, contentEnd);
      const rendered = `${key} = ${serializeTomlValue(value)}`;
      if (index === null) {
        let insertAt = contentEnd;
        while (insertAt > block.headerIndex + 1 && lines[insertAt - 1]?.trim() === "") {
          insertAt -= 1;
        }
        lines.splice(insertAt, 0, rendered);
      } else {
        const replaced = replaceValueKeepingComment(lines[index]!, key, value, path);
        lines[index] = replaced;
      }
    }
  }

  const result = lines.join("\n");
  parseTomlText(result, path);
  return result;
}

export function removeTomlTable(text: string, tablePath: string[], path: string): string {
  assertBarePath(tablePath, path);
  const lines = toLines(text);
  const blocks = findBlocks(lines);
  const matches = blocks.filter(
    (block) =>
      samePath(block.path, tablePath) ||
      (block.path.length > tablePath.length &&
        samePath(block.path.slice(0, tablePath.length), tablePath)),
  );
  if (matches.length === 0) return text;

  for (const block of [...matches].reverse()) {
    lines.splice(block.headerIndex, block.endIndex - block.headerIndex);
  }
  trimLeadingBlank(lines);

  const result = lines.join("\n");
  parseTomlText(result, path);
  return result;
}

export function setTomlTopLevel(
  text: string,
  key: string,
  value: TomlScalar,
  path: string,
): string {
  assertBarePath([key], path);
  const lines = toLines(text);
  const blocks = findBlocks(lines);
  const topEnd = blocks[0]?.headerIndex ?? lines.length;
  const index = findTopLevelKeyLine(lines, topEnd, key);
  if (index === null) {
    let insertAt = topEnd;
    while (insertAt > 0 && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, `${key} = ${serializeTomlValue(value)}`);
  } else {
    lines[index] = replaceValueKeepingComment(lines[index]!, key, value, path);
  }
  const result = lines.join("\n");
  parseTomlText(result, path);
  return result;
}

export function removeTomlTopLevel(text: string, key: string, path: string): string {
  assertBarePath([key], path);
  const lines = toLines(text);
  const blocks = findBlocks(lines);
  const topEnd = blocks[0]?.headerIndex ?? lines.length;
  const index = findTopLevelKeyLine(lines, topEnd, key);
  if (index === null) return text;
  lines.splice(index, 1);
  const result = lines.join("\n");
  parseTomlText(result, path);
  return result;
}

function toLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split("\n");
}

function findBlocks(lines: string[]): Block[] {
  const headers: Array<{ index: number; path: string[] }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADER.exec(lines[index] ?? "");
    if (match !== null) headers.push({ index, path: splitKey(match[1]!) });
  }
  return headers.map((header, index) => ({
    path: header.path,
    headerIndex: header.index,
    endIndex: index + 1 < headers.length ? headers[index + 1]!.index : lines.length,
  }));
}

function splitKey(raw: string): string[] {
  return raw
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => part !== "");
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function findSubtableStart(lines: string[], block: Block, tablePath: string[]): number {
  for (let index = block.headerIndex + 1; index < block.endIndex; index += 1) {
    const match = HEADER.exec(lines[index] ?? "");
    if (match === null) continue;
    const candidate = splitKey(match[1]!);
    if (
      candidate.length > tablePath.length &&
      samePath(candidate.slice(0, tablePath.length), tablePath)
    ) {
      return index;
    }
  }
  return block.endIndex;
}

function findKeyLine(
  lines: string[],
  block: Block,
  key: string,
  contentEnd: number,
): number | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = block.headerIndex + 1; index < contentEnd; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index;
  }
  return null;
}

function findTopLevelKeyLine(
  lines: string[],
  end: number,
  key: string,
): number | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = 0; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index;
  }
  return null;
}

function replaceValueKeepingComment(
  line: string,
  key: string,
  value: TomlScalar,
  path: string,
): string {
  const equals = line.indexOf("=");
  if (equals < 0) throw invalidLine(path, key);
  const rest = line.slice(equals + 1);
  const { valueText, comment } = splitValueAndComment(rest);
  if (isMultilineValue(valueText)) {
    throw new ConfigKitError({
      code: "UNSUPPORTED_INTENT",
      message: `Refusing to rewrite a multi-line TOML value for "${key}"`,
      phase: "parse",
      path,
      field: key,
    });
  }
  const indent = line.slice(0, line.search(/\S/));
  const rendered = `${indent}${key} = ${serializeTomlValue(value)}`;
  return comment === null ? rendered : `${rendered} ${comment}`;
}

function splitValueAndComment(rest: string): { valueText: string; comment: string | null } {
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (inBasic) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (char === "'") inLiteral = false;
      continue;
    }
    if (char === '"') inBasic = true;
    else if (char === "'") inLiteral = true;
    else if (char === "#") {
      return { valueText: rest.slice(0, index), comment: rest.slice(index) };
    }
  }
  return { valueText: rest, comment: null };
}

function isMultilineValue(valueText: string): boolean {
  const trimmed = valueText.trim();
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return true;
  if (trimmed.startsWith("[")) {
    let depth = 0;
    let inBasic = false;
    let inLiteral = false;
    let escaped = false;
    for (const char of trimmed) {
      if (inBasic) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inBasic = false;
        continue;
      }
      if (inLiteral) {
        if (char === "'") inLiteral = false;
        continue;
      }
      if (char === '"') inBasic = true;
      else if (char === "'") inLiteral = true;
      else if (char === "[") depth += 1;
      else if (char === "]") depth -= 1;
    }
    return depth !== 0 || inBasic || inLiteral;
  }
  return false;
}

export function serializeTomlValue(value: TomlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TOML numbers must be finite");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
}

function assertBarePath(pathParts: string[], path: string): void {
  for (const part of pathParts) {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) {
      throw new ConfigKitError({
        code: "UNSUPPORTED_INTENT",
        message: `TOML key "${part}" requires quoting and is not supported`,
        phase: "parse",
        path,
        field: part,
      });
    }
  }
}

function ensureTrailingBlank(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") lines.push("");
}

function trimLeadingBlank(lines: string[]): void {
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
}

function invalidLine(path: string, key: string): ConfigKitError {
  return new ConfigKitError({
    code: "UNPARSEABLE_CONFIG",
    message: `Unable to locate the value of "${key}"`,
    phase: "parse",
    path,
    field: key,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}