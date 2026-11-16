/** Replace every occurrence of the given secrets with a fixed marker. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

/**
 * Minimal line diff for previews. It is intentionally not a patch format: the
 * preview cannot be applied, it only explains semantic changes.
 */
export function diffLines(before: string, after: string, maxLines = 240): string {
  if (before === after) return "";
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length * right.length > 4_000_000) {
    return "File content changed (diff too large to display).";
  }

  const lcs: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        left[i] === right[j]
          ? (lcs[i + 1]![j + 1]! + 1)
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`-${left[i]}`);
      i += 1;
    } else {
      out.push(`+${right[j]}`);
      j += 1;
    }
  }
  while (i < left.length) {
    out.push(`-${left[i]}`);
    i += 1;
  }
  while (j < right.length) {
    out.push(`+${right[j]}`);
    j += 1;
  }

  const trimmed = trimContext(out);
  if (trimmed.length > maxLines) {
    return `${trimmed.slice(0, maxLines).join("\n")}\n… (truncated)`;
  }
  return trimmed.join("\n");
}

/** Keep three lines of context around each change. */
function trimContext(lines: string[]): string[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith(" ")) continue;
    for (let k = Math.max(0, index - 3); k <= Math.min(lines.length - 1, index + 3); k += 1) {
      keep[k] = true;
    }
  }
  const result: string[] = [];
  let skipped = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (keep[index]) {
      if (skipped) result.push("…");
      skipped = false;
      result.push(lines[index]!);
    } else {
      skipped = true;
    }
  }
  return result;
}