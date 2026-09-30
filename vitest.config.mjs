import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The server test spawns a process on a port; keep files sequential.
    fileParallelism: false,
  },
});
