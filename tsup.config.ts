import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  // The models.dev client is ESM-only. Bundling it keeps the CJS entry usable
  // without depending on Node's require(esm) support.
  noExternal: ["@opencode-ai/models"],
  external: ["jsonc-parser", "yaml"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});