# coding-agent-config-kit

Plan and safely apply third-party provider/model configuration for coding
agents (Claude Code, Codex, Gemini CLI, OpenCode, Pi, DeepSeek Harness).

The design contract lives in [docs/technical-design-v1.md](docs/technical-design-v1.md).
Implementation is in progress: the safety primitives (atomic writes, single-target
lock, recovery journal, management record) and public types are in place.

## Status

- [x] TypeScript project, ESM + CJS build, Node 20+
- [x] Atomic writes, lock protocol, recovery journal, ownership record
- [x] Model discovery (OpenAI / Anthropic / Google formats, pagination)
- [x] models.dev snapshot by default, explicit live mode with fallback
- [x] Field-level capability resolution and projectability
- [x] CI on macOS, Windows and Linux (Node 20/22)
- [ ] Agent adapters and default-model add-on
- [ ] `resolveAndPlan` / `apply` / `inspectRecovery` / `recover`

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check` runs all three.