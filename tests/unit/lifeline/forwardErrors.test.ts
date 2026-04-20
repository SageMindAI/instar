import { describe, it, expect } from 'vitest';
import {
  ForwardTransientError,
  ForwardBadRequestError,
  ForwardServerBootError,
  ForwardVersionSkewError,
  isTerminalForwardError,
} from '../../../src/lifeline/forwardErrors.js';

describe('forwardErrors', () => {
  it('isTerminalForwardError: true for 426/400', () => {
    expect(isTerminalForwardError(new ForwardVersionSkewError(426, {}))).toBe(true);
    expect(isTerminalForwardError(new ForwardBadRequestError({}))).toBe(true);
  });

  it('isTerminalForwardError: false for transient / boot / unknown', () => {
    expect(isTerminalForwardError(new ForwardTransientError(500))).toBe(false);
    expect(isTerminalForwardError(new ForwardServerBootError(1000))).toBe(false);
    expect(isTerminalForwardError(new Error('random'))).toBe(false);
    expect(isTerminalForwardError('string')).toBe(false);
    expect(isTerminalForwardError(null)).toBe(false);
  });

  it('ForwardVersionSkewError carries body', () => {
    const err = new ForwardVersionSkewError(426, {
      upgradeRequired: true,
      serverVersion: '1.2.3',
      action: 'restart',
    });
    expect(err.body.serverVersion).toBe('1.2.3');
    expect(err.kind).toBe('version-skew');
  });

  it('ForwardServerBootError carries retryAfterMs', () => {
    const err = new ForwardServerBootError(5000);
    expect(err.retryAfterMs).toBe(5000);
  });
});
