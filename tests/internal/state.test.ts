import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emptyManagementRecord,
  readManagement,
  writeManagement,
} from "../../src/internal/state.js";

let dir: string;
let statePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-state-"));
  statePath = join(dir, ".coding-agent-config-kit", "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("management record", () => {
  it("returns null when nothing has been recorded", async () => {
    expect(await readManagement(statePath)).toBeNull();
  });

  it("round-trips entries", async () => {
    const record = emptyManagementRecord("owner", "pi", dir);
    record.entries["provider:company"] = {
      kind: "provider",
      fields: ["baseUrl", "apiKey"],
      baseline: { baseUrl: "https://api.example.com/v1" },
    };
    await writeManagement(statePath, record);

    const loaded = await readManagement(statePath);
    expect(loaded?.entries["provider:company"]?.fields).toEqual(["baseUrl", "apiKey"]);

    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects malformed records", async () => {
    await mkdir(join(dir, ".coding-agent-config-kit"), { recursive: true });
    await writeFile(statePath, "{ nope", "utf8");
    await expect(readManagement(statePath)).rejects.toMatchObject({
      code: "UNPARSEABLE_CONFIG",
    });
  });
});