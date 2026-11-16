#!/usr/bin/env node
/**
 * Verify that the checked-in acceptance fixtures still match the Agent CLIs
 * installed on this machine. This only runs each CLI with `--version`; it never
 * launches an agent, reads user configuration, or writes outside a temp dir.
 *
 * Usage: node scripts/verify-agents.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const registry = JSON.parse(readFileSync(join(root, "fixtures", "versions.json"), "utf8"));
const fixturesRoot = join(root, "fixtures", "agents");
const binaries = {
  "claude-code": "claude",
  codex: "codex",
  "gemini-cli": "gemini",
  opencode: "opencode",
  pi: "pi",
  "deepseek-harness": "dsh",
};

const temp = await mkdtemp(join(tmpdir(), "config-kit-agent-check-"));
let failures = 0;

try {
  console.log("agent                  expected          observed          result");
  console.log("-".repeat(74));

  for (const [agent, entry] of Object.entries(registry.agents)) {
    const expected = entry.version ?? "(not installed)";
    if (entry.status !== "installed") {
      console.log(
        `${agent.padEnd(22)} ${String(expected).padEnd(17)} ${"(skipped)".padEnd(17)} skip`,
      );
      continue;
    }

    const binary = binaries[agent];
    if (binary === undefined) {
      console.log(`${agent.padEnd(22)} ${expected.padEnd(17)} unknown binary     FAIL`);
      failures += 1;
      continue;
    }

    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        HOME: temp,
        XDG_DATA_HOME: join(temp, "data"),
        XDG_CONFIG_HOME: join(temp, "config"),
      },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
    const observed = match?.[1] ?? "(unparsed)";
    const versionOk = observed === expected;
    const fixtureOk = hasFixture(agent, entry.version);
    const ok = versionOk && fixtureOk;
    if (!ok) failures += 1;

    console.log(
      `${agent.padEnd(22)} ${expected.padEnd(17)} ${observed.padEnd(17)} ${
        ok ? "ok" : versionOk ? "missing fixture" : "FAIL"
      }`,
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} version/fixture check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll installed Agent versions match the checked-in fixtures.");
}

function hasFixture(agent, version) {
  const dir = join(fixturesRoot, agent);
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .some((entry) => {
      const manifestPath = join(dir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return manifest.version === version;
    });
}