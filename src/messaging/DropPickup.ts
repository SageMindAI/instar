/**
 * DropPickup — ingest messages from the drop directory on server startup.
 *
 * When an agent is offline, other agents on the same machine write messages
 * to ~/.instar/messages/drop/{agentName}/. On startup, this module scans
 * the drop directory, verifies each envelope's HMAC, ingests valid messages,
 * and cleans up processed files.
 *
 * Security: Each dropped envelope carries an HMAC-SHA256 computed with the
 * sending agent's token. This prevents local processes from forging messages
 * or tampering with routing metadata via the drop directory.
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1 §Cross-Agent Resolution
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MessageEnvelope } from './types.js';
import type { MessageStore } from './MessageStore.js';
import { verifyDropHmac } from './AgentTokenManager.js';

export interface DropPickupResult {
  /** Number of messages successfully ingested */
  ingested: number;
  /** Number of messages rejected (invalid HMAC, bad format, etc.) */
  rejected: number;
  /** Number of messages skipped (already in store — dedup) */
  duplicates: number;
  /** Details of rejected messages for logging */
  rejections: Array<{ file: string; reason: string }>;
}

/**
 * Scan the drop directory for this agent and ingest valid messages.
 *
 * @param agentName - This agent's name (used to locate drop dir and verify auth)
 * @param store - The message store to ingest into
 * @returns Summary of what was processed
 */
export async function pickupDroppedMessages(
  agentName: string,
  store: MessageStore,
): Promise<DropPickupResult> {
  const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', agentName);

  const result: DropPickupResult = {
    ingested: 0,
    rejected: 0,
    duplicates: 0,
    rejections: [],
  };

  // No drop directory = nothing to pick up
  if (!fs.existsSync(dropDir)) {
    return result;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dropDir).filter(f => f.endsWith('.json'));
  } catch {
    // @silent-fallback-ok — directory not readable, nothing to process
    return result;
  }

  for (const file of files) {
    const filePath = path.join(dropDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const envelope: MessageEnvelope = JSON.parse(raw);

      // Validate envelope structure
      if (!envelope?.message?.id || !envelope?.transport || !envelope?.delivery) {
        result.rejected++;
        result.rejections.push({ file, reason: 'invalid envelope structure' });
        unlinkSafe(filePath);
        continue;
      }

      // Deduplication: skip if already in store
      if (await store.exists(envelope.message.id)) {
        result.duplicates++;
        unlinkSafe(filePath);
        continue;
      }

      // Verify HMAC if present
      if (envelope.transport.hmac && envelope.transport.hmacBy) {
        const valid = verifyDropHmac(
          envelope.transport.hmacBy,
          envelope.transport.hmac,
          {
            message: envelope.message,
            originServer: envelope.transport.originServer,
            nonce: envelope.transport.nonce,
            timestamp: envelope.transport.timestamp,
          },
        );

        if (!valid) {
          result.rejected++;
          result.rejections.push({ file, reason: `invalid HMAC from ${envelope.transport.hmacBy}` });
          unlinkSafe(filePath);
          continue;
        }
      } else {
        // No HMAC — reject (spec requires HMAC on all drops)
        result.rejected++;
        result.rejections.push({ file, reason: 'missing HMAC' });
        unlinkSafe(filePath);
        continue;
      }

      // Update delivery phase to 'received'
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: envelope.delivery.phase, to: 'received', at: now, reason: 'picked up from drop directory' },
        ],
      };

      // Ingest into store
      await store.save(envelope);
      result.ingested++;

      // Clean up processed file
      unlinkSafe(filePath);
    } catch {
      // @silent-fallback-ok — malformed file, skip it
      result.rejected++;
      result.rejections.push({ file, reason: 'parse error or I/O failure' });
      unlinkSafe(filePath);
    }
  }

  return result;
}

/** Safely delete a file, ignoring errors */
function unlinkSafe(filePath: string): void {
  try {
    // safe-git-allow: incremental-migration
    fs.unlinkSync(filePath);
  } catch {
    // @silent-fallback-ok — file may already be deleted
  }
}
