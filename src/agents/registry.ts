import type { AgentId } from "../types.js";
import { ConfigKitError } from "../errors.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { piAdapter } from "./pi.js";
import type { AgentAdapter } from "./types.js";

const ADAPTERS: Partial<Record<AgentId, AgentAdapter>> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
};

export function getAdapter(agent: AgentId): AgentAdapter {
  const adapter = ADAPTERS[agent];
  if (adapter === undefined) {
    throw new ConfigKitError({
      code: "UNSUPPORTED_AGENT",
      message: `No adapter is implemented for ${agent} yet`,
      agent,
      phase: "validate",
    });
  }
  return adapter;
}

export function supportedAgents(): AgentId[] {
  return Object.keys(ADAPTERS) as AgentId[];
}