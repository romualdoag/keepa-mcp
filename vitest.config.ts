import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 150_000,
    hookTimeout: 30_000,
    // Cinturão e suspensórios: SQLite em memória por padrão nos testes
    // (o isolamento real vem do __resetForTests(':memory:') no beforeEach).
    env: { KEEPA_CACHE_PATH: ":memory:" },
  },
});
