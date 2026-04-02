/**
 * OutboundAuditLog — Append-only JSONL logger for all outbound message attempts.
 *
 * Logs every outbound attempt (allowed or blocked) with:
 * - Masked recipient (PII protection)
 * - SHA-256 hashes for correlation (recipient + content)
 * - Which enforcement layer blocked (if blocked)
 * - Rate limit status at time of attempt
 * - Send mode (reactive vs proactive)
 *
 * No plaintext message content or phone numbers are stored.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export interface AuditEntry {
  timestamp: string;
  recipient: string;         // masked
  recipientHash: string;     // SHA-256 prefix for correlation
  textLength: number;
  textHash: string;          // SHA-256 of content
  allowed: boolean;
  blockedBy: string | null;  // e.g., "layer1:script", "layer3:sendDisabled", "layer4:rateLimit"
  sendMode: 'reactive' | 'proactive';
  sessionName: string | null;
  sendToken: string | null;  // first 8 chars for correlation
  rateStatus: { contactHour: number; globalDay: number };
}

export class OutboundAuditLog {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  /**
   * Record an outbound attempt.
   */
  record(entry: {
    recipient: string;
    text: string;
    allowed: boolean;
    blockedBy?: string;
    sendMode?: 'reactive' | 'proactive';
    sessionName?: string;
    sendToken?: string;
    rateStatus?: { contactHour: number; globalDay: number };
  }): void {
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      recipient: maskIdentifier(entry.recipient),
      recipientHash: sha256Prefix(entry.recipient),
      textLength: entry.text.length,
      textHash: sha256Prefix(entry.text),
      allowed: entry.allowed,
      blockedBy: entry.blockedBy || null,
      sendMode: entry.sendMode || 'reactive',
      sessionName: entry.sessionName || null,
      sendToken: entry.sendToken ? entry.sendToken.slice(0, 8) : null,
      rateStatus: entry.rateStatus || { contactHour: 0, globalDay: 0 },
    };

    try {
      fs.appendFileSync(this.logPath, JSON.stringify(auditEntry) + '\n');
    } catch (err) {
      console.error(`[imessage-audit] Failed to write audit log: ${(err as Error).message}`);
    }
  }
}

function sha256Prefix(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function maskIdentifier(id: string): string {
  if (id.startsWith('+') && id.length > 6) {
    return id.slice(0, 4) + '***' + id.slice(-4);
  }
  if (id.includes('@')) {
    const [local, domain] = id.split('@');
    return local.slice(0, 2) + '***@' + domain;
  }
  return '***';
}
