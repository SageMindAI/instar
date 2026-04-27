import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    setupFiles: ['./tests/vitest-setup.ts'],
    environment: 'node',
    testTimeout: 10000,
    // Run test files sequentially to prevent port collisions, file lock
    // contention, and resource races across files that spawn HTTP servers,
    // SQLite DBs, real npm operations, etc. Individual tests within each
    // file still run sequentially (vitest default for same-file tests).
    fileParallelism: false,
  },
});
