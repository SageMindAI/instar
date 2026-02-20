/**
 * Tests for server temp file cleanup.
 *
 * Verifies that cleanupTelegramTempFiles() exists in server.ts
 * and is called on startup.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Server — temp file cleanup', () => {
  const sourcePath = path.join(process.cwd(), 'src/commands/server.ts');
  let source: string;

  source = fs.readFileSync(sourcePath, 'utf-8');

  it('defines cleanupTelegramTempFiles function', () => {
    expect(source).toContain('function cleanupTelegramTempFiles');
  });

  it('targets /tmp/instar-telegram directory', () => {
    const cleanupSection = source.slice(
      source.indexOf('function cleanupTelegramTempFiles'),
      source.indexOf('export async function startServer')
    );
    expect(cleanupSection).toContain('/tmp/instar-telegram');
  });

  it('uses 7-day max age for temp files', () => {
    const cleanupSection = source.slice(
      source.indexOf('function cleanupTelegramTempFiles'),
      source.indexOf('export async function startServer')
    );
    expect(cleanupSection).toContain('7 * 24 * 60 * 60 * 1000');
  });

  it('only removes files, not directories', () => {
    const cleanupSection = source.slice(
      source.indexOf('function cleanupTelegramTempFiles'),
      source.indexOf('export async function startServer')
    );
    expect(cleanupSection).toContain('stat.isFile()');
  });

  it('handles missing directory gracefully', () => {
    const cleanupSection = source.slice(
      source.indexOf('function cleanupTelegramTempFiles'),
      source.indexOf('export async function startServer')
    );
    expect(cleanupSection).toContain('existsSync');
  });

  it('is called on foreground server start', () => {
    const startSection = source.slice(source.indexOf('if (options.foreground)'));
    expect(startSection).toContain('cleanupTelegramTempFiles()');
  });

  it('logs cleanup count when files were removed', () => {
    const cleanupSection = source.slice(
      source.indexOf('function cleanupTelegramTempFiles'),
      source.indexOf('export async function startServer')
    );
    expect(cleanupSection).toContain('Removed');
    expect(cleanupSection).toContain('stale temp files');
  });
});
