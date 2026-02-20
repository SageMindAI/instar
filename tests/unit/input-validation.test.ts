/**
 * Tests for input validation on HTTP endpoints.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('Input Validation', () => {
  const routesSrc = fs.readFileSync('src/server/routes.ts', 'utf-8');

  it('validates session name length on spawn', () => {
    expect(routesSrc).toContain('name.length > 200');
    expect(routesSrc).toContain('"name" must be a string under 200 characters');
  });

  it('validates prompt length on spawn', () => {
    expect(routesSrc).toContain('prompt.length > 500_000');
    expect(routesSrc).toContain('"prompt" must be a string under 500KB');
  });

  it('validates model enum on spawn', () => {
    expect(routesSrc).toContain("['opus', 'sonnet', 'haiku'].includes(model)");
  });

  it('validates input text length on session input', () => {
    expect(routesSrc).toContain('text.length > 100_000');
    expect(routesSrc).toContain('Input text exceeds maximum length');
  });

  it('validates session status query parameter', () => {
    expect(routesSrc).toContain('validStatuses');
    expect(routesSrc).not.toContain('status as any');
  });

  it('uses execFileSync (not execSync) for tmux listing', () => {
    expect(routesSrc).not.toContain('execSync(');
    expect(routesSrc).toContain('execFileSync(');
  });

  it('validates topicId is a number on telegram reply', () => {
    expect(routesSrc).toContain('isNaN(topicId)');
    expect(routesSrc).toContain('topicId must be a number');
  });

  it('has quota endpoint', () => {
    expect(routesSrc).toContain("router.get('/quota'");
  });
});
