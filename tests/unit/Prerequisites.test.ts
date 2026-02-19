/**
 * Unit tests for prerequisite detection.
 */

import { describe, it, expect } from 'vitest';
import { checkPrerequisites } from '../../src/core/Prerequisites.js';

describe('Prerequisites', () => {
  it('returns structured results for all checks', () => {
    const result = checkPrerequisites();

    expect(result.results).toHaveLength(3);
    expect(result.results.map(r => r.name)).toEqual(['Node.js', 'tmux', 'Claude CLI']);

    // Each result has the expected shape
    for (const r of result.results) {
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('found');
      expect(r).toHaveProperty('installHint');
    }
  });

  it('detects Node.js version correctly', () => {
    const result = checkPrerequisites();
    const node = result.results.find(r => r.name === 'Node.js')!;

    expect(node.found).toBe(true); // We're running tests, so Node must be available
    expect(node.version).toMatch(/^v\d+/);
  });

  it('reports allMet based on found status', () => {
    const result = checkPrerequisites();

    // allMet should be true only if everything is found
    const allFound = result.results.every(r => r.found);
    expect(result.allMet).toBe(allFound);
  });

  it('missing array contains only unfound prerequisites', () => {
    const result = checkPrerequisites();

    for (const m of result.missing) {
      expect(m.found).toBe(false);
    }

    // missing.length + found.length should equal total
    const foundCount = result.results.filter(r => r.found).length;
    expect(result.missing.length + foundCount).toBe(result.results.length);
  });

  it('provides install hints for all results', () => {
    const result = checkPrerequisites();

    // Missing items should have non-empty install hints
    for (const m of result.missing) {
      expect(m.installHint.length).toBeGreaterThan(0);
    }
  });
});
