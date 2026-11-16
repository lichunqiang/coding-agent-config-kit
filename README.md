# coding-agent-config-kit

Plan and safely apply third-party provider/model configuration for coding
agents. The design contract lives in
[docs/technical-design-v1.md](docs/technical-design-v1.md).

> Status: the **Pi adapter** works end to end (`resolveAndPlan`, `apply`,
> `inspectRecovery`, `recover`). The other five adapters are still pending.

## Install

```sh
npm install coding-agent-config-kit
```

Node.js 20 or newer.

## Usage

```ts
import { createConfigKit, defaultModel } from "coding-agent-config-kit";

const kit = createConfigKit({
  ownerId: "my-switcher",
  resolveCredential: async (ref) => accountStore.resolve(ref),
  addons: [defaultModel({ modelId: "deepseek-4.1-flash-company" })],
});

const plan = await kit.resolveAndPlan({
  agent: "pi",
  target: {
    configDir: "/absolute/path/to/pi-agent",
    launchEnvironment: { PI_CODING_AGENT_DIR: "/absolute/path/to/pi-agent" },
  },
  provider: {
    id: "company-deepseek",
    protocol: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    credential: {
      source: { kind: "reference", id: "account-123" },
      placement: { kind: "env-reference", envVar: "COMPANY_DEEPSEEK_KEY" },
    },
  },
  models: {
    fallbackIds: ["deepseek-4.1-flash-company"],
    overrides: {
      "deepseek-4.1-flash-company": { contextWindow: 64_000 },
    },
  },
});

console.log(plan.preview); // redacted, serializable plan preview
const result = await kit.apply(plan); // no writes on a second apply
```

`apply()` returns `unchanged` when nothing differs, acquires a per-target lock,
writes through a recovery journal, and never overwrites a file changed after
planning. `inspectRecovery()` and `recover()` handle interrupted commits.

## Status

- [x] TypeScript package, ESM + CJS, Node 20+
- [x] Atomic writes, lock protocol, recovery journal, ownership record
- [x] Model discovery (OpenAI / Anthropic / Google formats, pagination)
- [x] models.dev snapshot by default, explicit live mode with fallback
- [x] Field-level capability resolution and projectability
- [x] Pi adapter and `defaultModel` add-on
- [x] Pi `resolveAndPlan` / `apply` / `inspectRecovery` / `recover`
- [ ] Claude Code, Codex, Gemini CLI, OpenCode, DeepSeek Harness adapters
- [ ] Full platform matrix for permissions and recovery

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check   # all of the above
```

CI runs typecheck, tests and build on macOS, Windows and Linux with Node 20
and 22.