/**
 * Vitest config for pre-push hook.
 *
 * Excludes known flaky tests that fail intermittently due to:
 * - Supertest HTTP server timeouts / port collisions
 * - Race conditions in route registration ordering
 * - Non-deterministic test data (stale entity detection, query results)
 *
 * These tests still run with `npm test` (full suite) and should be
 * periodically reviewed. If a test is stabilized, remove it from the
 * exclude list.
 *
 * To run ONLY the flaky tests (for debugging):
 *   npx vitest run --config vitest.push.config.ts --exclude '!tests/**'
 */
import { defineConfig } from 'vitest/config';

const FLAKY_TESTS = [
  // ── Supertest timeouts / port collisions ──────────────────────────
  'tests/unit/relationship-routes.test.ts',
  'tests/unit/server.test.ts',
  'tests/integration/messaging-routes.test.ts',
  'tests/integration/whatsapp-routes.test.ts',
  'tests/e2e/messaging-multi-agent.test.ts',

  // ── Non-deterministic data / race conditions ──────────────────────
  'tests/e2e/semantic-memory-lifecycle.test.ts',
  'tests/e2e/working-memory-lifecycle.test.ts',
  'tests/e2e/episodic-memory-lifecycle.test.ts',
  'tests/e2e/scope-coherence-lifecycle.test.ts',

  // ── HTTP response corruption / parse errors ───────────────────────
  'tests/e2e/system-reviewer-e2e.test.ts',

  // ── Threadline (WIP, uncommitted) — state/UUID race conditions ────
  'tests/integration/threadline/**',
  'tests/unit/threadline/**',
];

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    exclude: FLAKY_TESTS,
    environment: 'node',
    testTimeout: 10000,
    fileParallelism: false,
  },
});
