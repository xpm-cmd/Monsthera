import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __MONSTHERA_VERSION__: JSON.stringify("3.0.0-alpha.0"),
  },
});
