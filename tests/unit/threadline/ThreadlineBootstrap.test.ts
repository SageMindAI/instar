/**
 * Tests for ThreadlineBootstrap — auto-wiring Threadline into the agent server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';

describe('ThreadlineBootstrap', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-bootstrap-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bootstraps successfully and returns all components', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });

    expect(result.handshakeManager).toBeDefined();
    expect(result.discovery).toBeDefined();
    expect(result.identityKeys).toBeDefined();
    expect(result.identityKeys.publicKey).toBeInstanceOf(Buffer);
    expect(result.identityKeys.privateKey).toBeInstanceOf(Buffer);
    expect(result.shutdown).toBeInstanceOf(Function);

    await result.shutdown();
  });

  it('persists identity keys across restarts', async () => {
    const result1 = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result1.shutdown();

    const result2 = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result2.shutdown();

    // Same keys across restarts
    expect(result1.identityKeys.publicKey.toString('hex'))
      .toBe(result2.identityKeys.publicKey.toString('hex'));
    expect(result1.identityKeys.privateKey.toString('hex'))
      .toBe(result2.identityKeys.privateKey.toString('hex'));
  });

  it('creates threadline directory structure', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    expect(fs.existsSync(path.join(stateDir, 'threadline'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'threadline', 'identity-keys.json'))).toBe(true);
  });

  it('writes identity keys with restrictive permissions', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const keyFile = path.join(stateDir, 'threadline', 'identity-keys.json');
    const stat = fs.statSync(keyFile);
    // File should be owner-only (0o600)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('registers MCP server in .mcp.json', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const mcpJsonPath = path.join(projectDir, '.mcp.json');
    expect(fs.existsSync(mcpJsonPath)).toBe(true);

    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    expect(mcpConfig.mcpServers.threadline).toBeDefined();
    expect(mcpConfig.mcpServers.threadline.command).toBe('node');
    expect(mcpConfig.mcpServers.threadline.args).toContain('--agent-name');
    expect(mcpConfig.mcpServers.threadline.args).toContain('test-agent');
  });

  it('preserves existing .mcp.json entries', async () => {
    // Pre-existing .mcp.json with playwright
    const mcpJsonPath = path.join(projectDir, '.mcp.json');
    fs.writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    }));

    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    // Both should exist
    expect(mcpConfig.mcpServers.playwright).toBeDefined();
    expect(mcpConfig.mcpServers.threadline).toBeDefined();
  });

  it('announces agent presence via discovery', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      agentDescription: 'A test agent for testing',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfoPath = path.join(stateDir, 'threadline', 'agent-info.json');
    expect(fs.existsSync(agentInfoPath)).toBe(true);

    const agentInfo = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(agentInfo.name).toBe('test-agent');
    expect(agentInfo.port).toBe(4040);
    expect(agentInfo.description).toBe('A test agent for testing');
    expect(agentInfo.capabilities).toContain('threadline');
    expect(agentInfo.capabilities).toContain('mcp');
    expect(agentInfo.publicKey).toBeDefined();
    expect(agentInfo.framework).toBe('instar');
  });

  it('handles corrupted identity key file gracefully', async () => {
    // Write corrupted key file
    const threadlineDir = path.join(stateDir, 'threadline');
    fs.mkdirSync(threadlineDir, { recursive: true });
    fs.writeFileSync(path.join(threadlineDir, 'identity-keys.json'), 'not valid json');

    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    // Should have regenerated valid keys
    expect(result.identityKeys.publicKey.length).toBe(32);
    expect(result.identityKeys.privateKey.length).toBe(32);
  });

  it('uses default description when none provided', async () => {
    const result = await bootstrapThreadline({
      agentName: 'my-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfoPath = path.join(stateDir, 'threadline', 'agent-info.json');
    const agentInfo = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(agentInfo.description).toBe('my-agent Instar agent');
  });

  it('shutdown stops heartbeat without error', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });

    // Should not throw
    await result.shutdown();
    // Double shutdown should also not throw
    await result.shutdown();
  });
});
