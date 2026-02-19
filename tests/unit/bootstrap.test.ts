/**
 * Unit tests for identity bootstrap.
 */

import { describe, it, expect } from 'vitest';
import { defaultIdentity } from '../../src/scaffold/bootstrap.js';

describe('defaultIdentity', () => {
  it('capitalizes project name for agent name', () => {
    const identity = defaultIdentity('my-agent');
    expect(identity.name).toBe('My-agent');
  });

  it('provides a general-purpose role', () => {
    const identity = defaultIdentity('test');
    expect(identity.role).toContain('general-purpose');
  });

  it('provides a personality', () => {
    const identity = defaultIdentity('test');
    expect(identity.personality.length).toBeGreaterThan(0);
  });

  it('defaults user name to User', () => {
    const identity = defaultIdentity('test');
    expect(identity.userName).toBe('User');
  });
});
