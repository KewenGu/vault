import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // setup：清掉真实服务的环境变量、默认 fetch 不许真实联网（见 src/test/setup.ts）
  test: { include: ["src/**/*.test.ts"], setupFiles: ["src/test/setup.ts"] },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "src/test/server-only-stub.ts"),
    },
  },
});
