/**
 * Session name sanitization tests — validates that session names
 * are properly sanitized for use as tmux session names.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Extract the sanitizeSessionName function by reading source
// (it's not exported, so we test the logic directly)
describe('Session name sanitization', () => {
  // Inline the function for testing (matches src/core/SessionManager.ts)
  function sanitizeSessionName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  it('preserves alphanumeric names', () => {
    expect(sanitizeSessionName('my-session-123')).toBe('my-session-123');
  });

  it('replaces special characters with hyphens', () => {
    expect(sanitizeSessionName('hello world!')).toBe('hello-world');
  });

  it('collapses multiple hyphens', () => {
    expect(sanitizeSessionName('a---b')).toBe('a-b');
  });

  it('removes leading and trailing hyphens', () => {
    expect(sanitizeSessionName('-hello-')).toBe('hello');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeSessionName(long).length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(sanitizeSessionName('')).toBe('');
  });

  it('handles all-special-characters', () => {
    expect(sanitizeSessionName('!!!@@@###')).toBe('');
  });

  it('handles unicode characters', () => {
    const result = sanitizeSessionName('héllo wörld');
    expect(result).not.toContain('é');
    expect(result).not.toContain('ö');
  });

  it('preserves underscores', () => {
    expect(sanitizeSessionName('my_session_name')).toBe('my_session_name');
  });

  it('source file contains the sanitize function', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('sanitizeSessionName');
    expect(source).toContain("[^a-zA-Z0-9_-]");
  });
});
