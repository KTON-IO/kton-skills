import { defineConfig } from "vitest/config";

// TonCenter allows one request a second without a key, and the SDK keeps to
// it even against fixtures, so a quote and a send take several seconds.
// test/sandbox runs inside the pool contract's checkout (its README).
export default defineConfig({
  test: { testTimeout: 30_000, exclude: ["**/node_modules/**", "test/sandbox/**"] },
});
