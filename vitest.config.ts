import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

// Tests import @c2p/core from source, so no build is needed first.
const coreSource = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@c2p\/core$/, replacement: coreSource }],
  },
  test: {
    reporters: ["default"],
    exclude: [...configDefaults.exclude, "Chandra/**", "ref-code/**", "reference/**"],
    projects: [
      {
        extends: true,
        test: { name: "core", environment: "node", include: ["packages/core/test/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "server", environment: "node", include: ["packages/server/test/**/*.test.ts"] },
      },
      {
        extends: true,
        plugins: [vue()],
        test: { name: "frontend", environment: "happy-dom", include: ["frontend/src/**/*.test.ts"] },
      },
    ],
  },
});
