import { join } from "node:path";

export const KIT_STATE_DIR = ".coding-agent-config-kit";

export interface KitPaths {
  dir: string;
  state: string;
  recovery: string;
  lock: string;
}

export function statePathForOwner(configDir: string, ownerId: string): string {
  const safe = ownerId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "owner";
  return join(kitPaths(configDir).dir, `state-${safe}.json`);
}

export function kitPaths(configDir: string): KitPaths {
  const dir = join(configDir, KIT_STATE_DIR);
  return {
    dir,
    state: join(dir, "state.json"),
    recovery: join(dir, "recovery.json"),
    lock: join(dir, "lock"),
  };
}