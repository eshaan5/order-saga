import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests wait on real HTTP calls with retries and backoff.
    testTimeout: 30_000,
    // Test FILES run sequentially. The integration suites share one MySQL
    // instance, and running them in parallel would have them competing for the
    // same rows — the failures would look like saga bugs rather than test
    // interference, which is the worst kind of flake to debug.
    fileParallelism: false,
  },
});
