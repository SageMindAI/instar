/**
 * Verifies that PostUpdateMigrator.getSessionStartHook() (the inline bash
 * template that actually gets installed on update) includes the
 * Integrated-Being ledger fetch.
 *
 * Spec: docs/specs/integrated-being-ledger-v1.md §"Session-start injection".
 */

import { describe, it, expect } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

describe('PostUpdateMigrator — Integrated-Being session-start injection', () => {
  const migrator = new PostUpdateMigrator({
    projectDir: '/tmp',
    stateDir: '/tmp/.instar',
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });

  // getSessionStartHook is private; cast for access.
  const hook = (migrator as unknown as { getSessionStartHook(): string }).getSessionStartHook();

  it('includes the /shared-state/render fetch', () => {
    expect(hook).toContain('/shared-state/render?limit=50');
  });

  it('wraps the fetch with a non-empty guard', () => {
    expect(hook).toContain('if [ -n "$SHARED_STATE" ]');
  });

  it('includes the INTEGRATED-BEING section header', () => {
    expect(hook).toContain('--- INTEGRATED-BEING');
  });

  it('uses bearer auth', () => {
    expect(hook).toContain('Authorization: Bearer');
  });

  it('reads auth token from config.json', () => {
    expect(hook).toMatch(/authToken/);
  });

  it('keeps the existing TOPIC CONTEXT block intact (no regression)', () => {
    expect(hook).toContain('CONVERSATION CONTEXT');
  });
});
