import { join } from "node:path";

export const KIT_STATE_DIR = ".coding-agent-config-kit";

export interface KitPaths {
  dir: string;
  state: string;
  recovery: string;
  lock: string;
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