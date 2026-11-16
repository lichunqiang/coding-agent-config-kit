# coding-agent-config-kit

Plan and safely apply third-party provider/model configuration for coding
agents. The design contract lives in
[docs/technical-design-v1.md](docs/technical-design-v1.md).

> Status: all six adapters are implemented and covered end to end
> (`resolveAndPlan`, `apply`, `inspectRecovery`, `recover`), with the
> limitations below.

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
- [x] Pi, Claude Code, Codex, Gemini CLI, OpenCode (V1 and V2) and DeepSeek Harness adapters
- [x] End-to-end `resolveAndPlan` / `apply` / `inspectRecovery` / `recover`
- [ ] Full platform matrix for permissions and recovery edge cases

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

## Adapters

| Agent | Files written | Credential placements |
| --- | --- | --- |
| Pi | `models.json`, `settings.json` | `env-reference`, `agent-file` |
| Claude Code | `settings.json` (`env` block) | `external-env`, `agent-file` |
| Codex | `config.toml` | `env-reference` (`env_key`) |
| Gemini CLI | `settings.json`, `.env` | `external-env`, `agent-file` |
| OpenCode | `opencode.json(c)` V1 `provider` or V2 `providers` | `env-reference` |
| DeepSeek Harness | profile `cordis.patch.yml` | `env-reference` |

The default model add-on uses each agent's native semantics: four `ANTHROPIC_*`
fields for Claude Code, `defaultProvider`/`defaultModel` plus `enabledModels`
for Pi, `model`/`model_provider` for Codex, `model.name` for Gemini CLI,
`provider/model` for OpenCode, and the `agent-default-model` entry for DSH.

## Known limitations

- OpenCode V2 writes the `aisdk:` package form plus `settings.baseURL` and
  `settings.apiKey`; the package mapping is an explicit assumption reported as a
  warning.
- OpenCode V1 requires `contextWindow` and `maxOutputTokens`; a model without
  both is refused with `REQUIRED_MODEL_FIELD_MISSING`.
- The default model add-on requires an existing `agent-default-model` entry for
  DeepSeek Harness; it does not create a new profile entry.
- Pi, Claude Code, Codex, Gemini CLI, OpenCode and DSH expose the credential
  placements listed above; unsupported placements fail during planning.
- Windows permissions rely on the inherited user-directory ACL; no system ACL
  APIs are called.
- Discovery supports `network.proxyUrl` (HTTP proxy) and `network.ca` (PEM
  bundle) through an undici dispatcher; both are not exercised against a real
  proxy or private CA in CI.

When strict sync would delete models, pass `confirmDeletions: true`:

```ts
await kit.apply(plan, { confirmDeletions: true });
```