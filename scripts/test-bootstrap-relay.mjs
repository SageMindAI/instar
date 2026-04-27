#!/usr/bin/env node
/**
 * Test the ThreadlineBootstrap relay connection flow against the live relay.
 *
 * This simulates what happens when an Instar agent boots with relayEnabled: true.
 * Uses a temporary state directory — does NOT modify any real agent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Create a temporary state directory
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-relay-test-'));
const stateDir = tmpDir;
const projectDir = tmpDir;

// Create minimal CLAUDE.md so bootstrap doesn't fail
fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test Agent\n');

console.log(`\nThreadline Bootstrap Relay Connection Test`);
console.log(`   State: ${stateDir}`);
console.log(`   Relay: wss://threadline-relay.fly.dev/v1/connect\n`);

try {
  // Dynamic import of the compiled module
  const { bootstrapThreadline } = await import('../dist/threadline/ThreadlineBootstrap.js');

  console.log('1. Bootstrapping with relayEnabled: true...');

  const result = await bootstrapThreadline({
    agentName: 'test-bootstrap-agent',
    agentDescription: 'Temporary test agent for relay bootstrap validation',
    stateDir,
    projectDir,
    port: 9999,
    relayEnabled: true,
    relayUrl: 'wss://threadline-relay.fly.dev/v1/connect',
    visibility: 'unlisted', // Don't pollute public discovery
    framework: 'instar',
    capabilities: ['test'],
  });

  console.log('2. Bootstrap completed!');
  console.log(`   Handshake manager: ${result.handshakeManager ? 'YES' : 'NO'}`);
  console.log(`   Discovery: ${result.discovery ? 'YES' : 'NO'}`);
  console.log(`   Trust manager: ${result.trustManager ? 'YES' : 'NO'}`);
  console.log(`   Relay client: ${result.relayClient ? 'CONNECTED' : 'NOT CONNECTED'}`);
  console.log(`   Inbound gate: ${result.inboundGate ? 'YES' : 'NO'}`);

  if (result.relayClient) {
    console.log(`   Fingerprint: ${result.relayClient.fingerprint}`);
    console.log(`   Connected: ${result.relayClient.connected}`);

    // Check that identity keys were persisted
    const keyFile = path.join(stateDir, 'threadline', 'identity-keys.json');
    if (fs.existsSync(keyFile)) {
      const keys = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
      console.log(`   Identity keys: persisted (created ${keys.createdAt})`);
    }

    // Check relay health to verify our connection appears
    try {
      const health = await fetch('https://threadline-relay.fly.dev/health');
      const data = await health.json();
      console.log(`   Relay health: ${data.connections} connections, ${data.registry?.totalAgents} registered`);
    } catch {}
  }

  // 3. Test shutdown
  console.log('\n3. Testing graceful shutdown...');
  await result.shutdown();
  console.log('   Shutdown complete');

  // Verify relay disconnected
  if (result.relayClient) {
    console.log(`   Relay connected after shutdown: ${result.relayClient.connected}`);
  }

  console.log('\n✓ Bootstrap relay connection test PASSED');
} catch (err) {
  console.error(`\n✗ Bootstrap relay connection test FAILED: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  // Cleanup
  try {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
