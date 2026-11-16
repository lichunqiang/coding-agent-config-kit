import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultModel } from "../../src/addons/default-model.js";
import { kitPaths } from "../../src/internal/paths.js";
import { TargetLock } from "../../src/internal/lock.js";
import { writeJournal } from "../../src/internal/journal.js";
import { sha256 } from "../../src/internal/hash.js";
import { createConfigKit } from "../../src/kit.js";
import type { ConfigKit, ResolveAndPlanRequest } from "../../src/types.js";

let dir: string;
let kit: ConfigKit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "config-kit-pi-"));
  kit = createConfigKit({
    ownerId: "owner",
    resolveCredential: (ref) => (ref === "acct" ? "super-secret-key" : ""),
    addons: [defaultModel({ modelId: "m1" })],
    lock: { timeoutMs: 300 },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function request(overrides: Partial<ResolveAndPlanRequest> = {}): ResolveAndPlanRequest {
  return {
    agent: "pi",
    target: {
      configDir: dir,
      launchEnvironment: { PI_CODING_AGENT_DIR: dir, TEST_KEY: "present" },
    },
    provider: {
      id: "company",
      protocol: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      credential: {
        source: { kind: "reference", id: "acct" },
        placement: { kind: "env-reference", envVar: "TEST_KEY" },
      },
    },
    models: {
      fallbackIds: ["m1"],
      overrides: { m1: { contextWindow: 64_000, maxOutputTokens: 8_000 } },
    },
    ...overrides,
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("Pi vertical slice", () => {
  it("plans, previews and applies provider plus default model", async () => {
    const plan = await kit.resolveAndPlan(request());
    expect(plan.preview.blockers).toEqual([]);
    expect(plan.preview.changes.map((change) => change.kind)).toEqual(["create", "create"]);
    expect(plan.preview.models[0]?.requestId).toBe("m1");

    const result = await kit.apply(plan);
    expect(result.status).toBe("applied");

    const models = await readJson(join(dir, "models.json"));
    const providers = models.providers as Record<string, Record<string, unknown>>;
    expect(providers.company?.baseUrl).toBe("https://api.example.com/v1");
    expect(providers.company?.api).toBe("openai-completions");
    expect(providers.company?.apiKey).toBe("$TEST_KEY");
    const piModels = providers.company?.models as Array<Record<string, unknown>>;
    expect(piModels).toHaveLength(1);
    expect(piModels[0]).toMatchObject({
      id: "m1",
      contextWindow: 64_000,
      maxTokens: 8_000,
    });

    const settings = await readJson(join(dir, "settings.json"));
    expect(settings.defaultProvider).toBe("company");
    expect(settings.defaultModel).toBe("m1");

    const state = await readJson(
      join(dir, ".coding-agent-config-kit", "state-owner.json"),
    );
    expect(state.ownerId).toBe("owner");
    expect((state.entries as Record<string, unknown>)["provider:company"]).toBeDefined();

    const second = await kit.resolveAndPlan(request());
    const again = await kit.apply(second);
    expect(again.status).toBe("unchanged");
  });

  it("reports an ownership conflict and can adopt explicitly", async () => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({ providers: { company: { baseUrl: "https://old.example.com" } } }),
      "utf8",
    );

    const blocked = await kit.resolveAndPlan(request());
    expect(blocked.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "OWNERSHIP_CONFLICT" }),
    );
    const failed = await kit.apply(blocked);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("OWNERSHIP_CONFLICT");

    const adopted = await kit.resolveAndPlan(
      request({ ownership: { adopt: ["company"] } }),
    );
    expect(adopted.preview.ownership.adopted).toContain("company");
    expect((await kit.apply(adopted)).status).toBe("applied");
  });

  it("refuses to overwrite a file changed after planning", async () => {
    const plan = await kit.resolveAndPlan(request());
    await writeFile(join(dir, "models.json"), '{"external":true}\n', "utf8");
    const result = await kit.apply(plan);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONFIG_CHANGED");
    expect(await readFile(join(dir, "models.json"), "utf8")).toBe('{"external":true}\n');
  });

  it("rejects a launch-environment credential that changed after planning", async () => {
    const req = request();
    const plan = await kit.resolveAndPlan(req);
    req.target.launchEnvironment!.TEST_KEY = "changed";
    const result = await kit.apply(plan);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CREDENTIAL_MISMATCH");
  });

  it("refuses a plan created by another SDK instance", async () => {
    const other = createConfigKit({
      ownerId: "owner",
      resolveCredential: () => "secret",
      lock: { timeoutMs: 300 },
    });
    const plan = await other.resolveAndPlan(request());
    await expect(kit.apply(plan)).rejects.toMatchObject({ code: "UNSAFE_TARGET" });
  });

  it("rejects an invalid provider baseUrl", async () => {
    await expect(
      kit.resolveAndPlan(
        request({
          provider: {
            ...request().provider!,
            baseUrl: "not a url",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "NETWORK_POLICY_DENIED" });
  });

  it("rejects model discovery without a provider", async () => {
    await expect(
      kit.resolveAndPlan({
        agent: "pi",
        target: { configDir: dir },
        models: { discovery: {} },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INTENT" });
  });

  it("detects a configDir/launchEnvironment mismatch", async () => {
    const plan = await kit.resolveAndPlan(
      request({
        target: {
          configDir: dir,
          launchEnvironment: { PI_CODING_AGENT_DIR: join(dir, "other"), TEST_KEY: "x" },
        },
      }),
    );
    expect(plan.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "TARGET_ENV_MISMATCH" }),
    );
    expect((await kit.apply(plan)).status).toBe("failed");
  });

  it("refuses to apply while a recovery record exists", async () => {
    const plan = await kit.resolveAndPlan(request());
    await writeJournal(kitPaths(dir).recovery, {
      schemaVersion: 1,
      transactionId: "tx",
      ownerId: "owner",
      agent: "pi",
      configDir: dir,
      status: "prepared",
      createdAt: new Date().toISOString(),
      files: [],
    });
    const result = await kit.apply(plan);
    expect(result.status).toBe("recovery-required");
    expect(result.error?.code).toBe("RECOVERY_REQUIRED");
  });

  it("returns locked when the target lock is held", async () => {
    const plan = await kit.resolveAndPlan(request());
    const lockPath = kitPaths(dir).lock;
    await mkdir(kitPaths(dir).dir, { recursive: true });
    const lock = await TargetLock.acquire(lockPath);
    try {
      const result = await kit.apply(plan);
      expect(result.status).toBe("locked");
    } finally {
      await lock.release();
    }
  });

  it("reports an unresolved env reference", async () => {
    const plan = await kit.resolveAndPlan(
      request({
        target: { configDir: dir, launchEnvironment: { PI_CODING_AGENT_DIR: dir } },
      }),
    );
    expect(plan.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "ENV_REFERENCE_UNRESOLVED" }),
    );
    const result = await kit.apply(plan);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ENV_REFERENCE_UNRESOLVED");
  });

  it("blocks on unknown required capabilities when configured", async () => {
    const plan = await kit.resolveAndPlan(
      request({
        models: {
          fallbackIds: ["m1"],
          unknownCapabilities: "block",
        },
      }),
    );
    expect(plan.preview.blockers).toContainEqual(
      expect.objectContaining({ code: "CAPABILITY_UNKNOWN" }),
    );
  });

  it("writes the state record with private permissions", async () => {
    await kit.apply(await kit.resolveAndPlan(request()));
    const statePath = join(dir, ".coding-agent-config-kit", "state-owner.json");
    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("recovery", () => {
  it("completes an interrupted commit when the file still matches the old content", async () => {
    const path = join(dir, "models.json");
    const before = '{"providers":{}}\n';
    const after = '{"providers":{"company":{"baseUrl":"https://api.example.com"}}}\n';
    await writeFile(path, before, "utf8");
    await writeJournal(kitPaths(dir).recovery, {
      schemaVersion: 1,
      transactionId: "tx",
      ownerId: "owner",
      agent: "pi",
      configDir: dir,
      status: "committing",
      createdAt: new Date().toISOString(),
      files: [
        {
          path,
          before: snapshot(before),
          after: snapshot(after),
        },
      ],
    });

    const result = await kit.recover({ agent: "pi", target: { configDir: dir } });
    expect(result.status).toBe("applied");
    expect(await readFile(path, "utf8")).toBe(after);
  });

  it("refuses to overwrite third-party content", async () => {
    const path = join(dir, "models.json");
    await writeFile(path, "third-party\n", "utf8");
    await writeJournal(kitPaths(dir).recovery, {
      schemaVersion: 1,
      transactionId: "tx",
      ownerId: "owner",
      agent: "pi",
      configDir: dir,
      status: "committing",
      createdAt: new Date().toISOString(),
      files: [
        {
          path,
          before: snapshot('{"old":true}\n'),
          after: snapshot('{"new":true}\n'),
        },
      ],
    });

    const result = await kit.recover({ agent: "pi", target: { configDir: dir } });
    expect(result.status).toBe("manual-intervention");
    expect(await readFile(path, "utf8")).toBe("third-party\n");
  });

  it("can restore the old content explicitly", async () => {
    const path = join(dir, "models.json");
    const before = '{"providers":{}}\n';
    const after = '{"providers":{"company":{}}}\n';
    await writeFile(path, after, "utf8");
    await writeJournal(kitPaths(dir).recovery, {
      schemaVersion: 1,
      transactionId: "tx",
      ownerId: "owner",
      agent: "pi",
      configDir: dir,
      status: "committing",
      createdAt: new Date().toISOString(),
      files: [{ path, before: snapshot(before), after: snapshot(after) }],
    });

    const result = await kit.recover(
      { agent: "pi", target: { configDir: dir } },
      { mode: "restore-old" },
    );
    expect(result.status).toBe("restored");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("reports a pending recovery record", async () => {
    await writeJournal(kitPaths(dir).recovery, {
      schemaVersion: 1,
      transactionId: "tx",
      ownerId: "owner",
      agent: "pi",
      configDir: dir,
      status: "prepared",
      createdAt: new Date().toISOString(),
      files: [],
    });
    const inspection = await kit.inspectRecovery({ agent: "pi", target: { configDir: dir } });
    expect(inspection.pending).toBe(true);
    expect(inspection.record?.transactionId).toBe("tx");
  });
});

function snapshot(text: string) {
  return {
    exists: true,
    sha256: sha256(text),
    contentBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}