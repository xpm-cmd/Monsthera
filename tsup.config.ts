import { defineConfig } from "tsup";

export default defineConfig([
  // Library + main index
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node22",
    dts: true,
    sourcemap: true,
    clean: true,
  },
  // CLI binary entry point
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    target: "node22",
    dts: false,
    sourcemap: true,
    clean: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
