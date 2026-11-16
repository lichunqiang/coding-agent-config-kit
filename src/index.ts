/**
 * coding-agent-config-kit
 *
 * Plan and apply third-party provider/model configuration for coding agents.
 * The public surface is defined in `docs/technical-design-v1.md`.
 */
export * from "./types.js";
export { createConfigKit } from "./kit.js";
export { defaultModel } from "./addons/default-model.js";
export { supportedAgents } from "./agents/registry.js";
