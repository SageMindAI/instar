/**
 * Tests that FeedbackManager uses cryptographically strong IDs.
 *
 * Verifies: IDs use UUID format (not Math.random),
 * all IDs start with 'fb-' prefix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import path from 'node:path';

describe('FeedbackManager crypto IDs', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  function createManager() {
    return new FeedbackManager({
      feedbackFile: path.join(project.stateDir, 'feedback.json'),
      enabled: false,
    });
  }

  it('generates IDs with fb- prefix', async () => {
    const mgr = createManager();
    const item = await mgr.submit({
      type: 'bug',
      title: 'Test',
      description: 'Test',
      agentName: 'test',
      instarVersion: '0.1.0',
      nodeVersion: 'v20',
      os: 'test',
    });

    expect(item.id).toMatch(/^fb-/);
  });

  it('generates IDs with UUID-derived segment (hex chars)', async () => {
    const mgr = createManager();
    const item = await mgr.submit({
      type: 'feature',
      title: 'Test',
      description: 'Test',
      agentName: 'test',
      instarVersion: '0.1.0',
      nodeVersion: 'v20',
      os: 'test',
    });

    // After 'fb-', the rest should be hex characters (from UUID)
    const suffix = item.id.slice(3);
    expect(suffix).toMatch(/^[0-9a-f-]+$/);
    expect(suffix.length).toBeGreaterThanOrEqual(8);
  });

  it('generates unique IDs across multiple submissions', async () => {
    const mgr = createManager();
    const ids = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const item = await mgr.submit({
        type: 'bug',
        title: `Test ${i}`,
        description: 'Test',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20',
        os: 'test',
      });
      ids.add(item.id);
    }

    expect(ids.size).toBe(10);
  });
});
