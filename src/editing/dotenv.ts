import { ConfigKitError } from "../errors.js";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = LINE.exec(line);
    if (match === null) continue;
    values[match[1]!] = unquote(match[2]!.trim());
  }
  return values;
}

export function getDotenv(text: string, key: string): string | undefined {
  return parseDotenv(text)[key];
}

export function setDotenv(text: string, key: string, value: string, path: string): string {
  assertKey(key, path);
  if (/[\r\n]/.test(value)) {
    throw new ConfigKitError({
      code: "UNSUPPORTED_INTENT",
      message: `Refusing to write a multi-line value for ${key}`,
      phase: "parse",
      path,
      field: key,
    });
  }
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`);
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i]!)) {
      index = i;
      break;
    }
  }
  const prefix = index >= 0 ? /^\s*(export\s+)?/.exec(lines[index]!)?.[1] ?? "" : "";
  const rendered = `${prefix}${key}=${formatValue(value)}`;
  if (index >= 0) lines[index] = rendered;
  else lines.push(rendered);
  return `${lines.join("\n")}\n`;
}

export function removeDotenv(text: string, key: string, path: string): string {
  assertKey(key, path);
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return text;
  lines.splice(index, 1);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function formatValue(value: string): string {
  if (value === "" || /[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function assertKey(key: string, path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new ConfigKitError({
      code: "UNSUPPORTED_INTENT",
      message: `Invalid dotenv key: ${key}`,
      phase: "parse",
      path,
      field: key,
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}