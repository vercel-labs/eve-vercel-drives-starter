import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    include: ["agent/**/*.test.ts", "scripts/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    setupFiles: ["agent/lib/testing/setup.ts"],
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
