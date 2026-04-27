import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionChannelRegistry } from '../../../src/messaging/shared/SessionChannelRegistry.js';

describe('SessionChannelRegistry', () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-registry-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRegistry() {
    return new SessionChannelRegistry({ registryPath });
  }

  // ── Registration ──────────────────────────────────────

  it('registers and retrieves channel-session mappings', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a', 'My Topic');

    expect(reg.getSessionForChannel('100')).toBe('session-a');
    expect(reg.getChannelForSession('session-a')).toBe('100');
    expect(reg.getChannelName('100')).toBe('My Topic');
  });

  it('handles registration without channel name', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a');

    expect(reg.getSessionForChannel('100')).toBe('session-a');
    expect(reg.getChannelName('100')).toBeNull();
  });

  it('unregisters channel-session mappings', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a');
    reg.unregister('100');

    expect(reg.getSessionForChannel('100')).toBeNull();
    expect(reg.getChannelForSession('session-a')).toBeNull();
  });

  it('overwrites existing mapping on re-register', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a');
    reg.register('100', 'session-b');

    expect(reg.getSessionForChannel('100')).toBe('session-b');
    expect(reg.getChannelForSession('session-b')).toBe('100');
  });

  it('returns null for unknown channels/sessions', () => {
    const reg = createRegistry();
    expect(reg.getSessionForChannel('999')).toBeNull();
    expect(reg.getChannelForSession('nonexistent')).toBeNull();
    expect(reg.getChannelName('999')).toBeNull();
  });

  // ── Purpose ──────────────────────────────────────────

  it('sets and gets channel purpose', () => {
    const reg = createRegistry();
    reg.setChannelPurpose('100', 'Technical');

    expect(reg.getChannelPurpose('100')).toBe('technical'); // lowercased
  });

  it('returns null for unset purpose', () => {
    const reg = createRegistry();
    expect(reg.getChannelPurpose('100')).toBeNull();
  });

  // ── All mappings ──────────────────────────────────────

  it('returns all mappings', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a', 'Topic A');
    reg.register('200', 'session-b', 'Topic B');
    reg.setChannelPurpose('100', 'billing');

    const mappings = reg.getAllMappings();
    expect(mappings).toHaveLength(2);

    const a = mappings.find(m => m.channelId === '100');
    expect(a?.sessionName).toBe('session-a');
    expect(a?.channelName).toBe('Topic A');
    expect(a?.channelPurpose).toBe('billing');
  });

  it('returns all channel-session pairs as Map', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a');
    reg.register('200', 'session-b');

    const map = reg.getAllChannelSessions();
    expect(map.size).toBe(2);
    expect(map.get('100')).toBe('session-a');
  });

  it('reports correct size', () => {
    const reg = createRegistry();
    expect(reg.size).toBe(0);
    reg.register('100', 'session-a');
    expect(reg.size).toBe(1);
    reg.register('200', 'session-b');
    expect(reg.size).toBe(2);
    reg.unregister('100');
    expect(reg.size).toBe(1);
  });

  // ── Persistence ──────────────────────────────────────

  it('persists and reloads from disk', () => {
    const reg1 = createRegistry();
    reg1.register('100', 'session-a', 'Topic A');
    reg1.setChannelPurpose('100', 'billing');

    // Create new instance from same path
    const reg2 = createRegistry();
    expect(reg2.getSessionForChannel('100')).toBe('session-a');
    expect(reg2.getChannelForSession('session-a')).toBe('100');
    expect(reg2.getChannelName('100')).toBe('Topic A');
    expect(reg2.getChannelPurpose('100')).toBe('billing');
  });

  it('starts fresh when registry file is missing', () => {
    const reg = createRegistry();
    expect(reg.size).toBe(0);
  });

  it('starts fresh when registry file is corrupted', () => {
    fs.writeFileSync(registryPath, 'not json{{{');
    const reg = createRegistry();
    expect(reg.size).toBe(0);
  });

  it('creates parent directory on save', () => {
    const deepPath = path.join(tmpDir, 'nested', 'deep', 'registry.json');
    const reg = new SessionChannelRegistry({ registryPath: deepPath });
    reg.register('100', 'session-a');
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  // ── Legacy compatibility ──────────────────────────────

  it('reads legacy topicToSession format', () => {
    fs.writeFileSync(registryPath, JSON.stringify({
      topicToSession: { '100': 'session-a', '200': 'session-b' },
      topicToName: { '100': 'Old Topic A' },
      topicToPurpose: { '100': 'billing' },
    }));

    const reg = createRegistry();
    expect(reg.getSessionForChannel('100')).toBe('session-a');
    expect(reg.getChannelName('100')).toBe('Old Topic A');
    expect(reg.getChannelPurpose('100')).toBe('billing');
    expect(reg.size).toBe(2);
  });

  it('writes both legacy and new keys for backward compatibility', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a');

    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(raw.channelToSession['100']).toBe('session-a');
    expect(raw.topicToSession['100']).toBe('session-a'); // legacy key
  });

  // ── Channel name update ──────────────────────────────

  it('updates channel name independently', () => {
    const reg = createRegistry();
    reg.register('100', 'session-a', 'Original Name');
    reg.setChannelName('100', 'Updated Name');

    expect(reg.getChannelName('100')).toBe('Updated Name');

    // Survives reload
    const reg2 = createRegistry();
    expect(reg2.getChannelName('100')).toBe('Updated Name');
  });
});
