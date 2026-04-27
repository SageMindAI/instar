/**
 * InstructionsVerifier — Tracks and verifies Claude Code instruction file loading.
 *
 * When Claude Code starts, it loads CLAUDE.md files and fires InstructionsLoaded
 * for each one. This module:
 *   1. Records which files loaded (called from the InstructionsLoaded hook)
 *   2. Verifies that expected files were loaded (called from session-start hook)
 *   3. Alerts if critical identity context is missing
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 3 (New Hook Events): InstructionsLoaded for identity verification (H4)
 *
 * Lifecycle:
 *   InstructionsLoaded fires (per file) -> recordLoad() appends to tracking file
 *   SessionStart fires (after all instructions load) -> verify() checks expectations
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export interface InstructionLoadRecord {
  /** ISO timestamp when recorded */
  timestamp: string;
  /** Path to the loaded instruction file */
  filePath: string;
  /** Memory type: User, Project, Local, Managed */
  memoryType: string;
  /** Why it loaded: eager (startup), lazy (subdirectory trigger) */
  loadReason?: string;
  /** Claude Code session ID */
  sessionId?: string;
}

export interface VerificationResult {
  /** Whether all expected files were found */
  passed: boolean;
  /** Files that were expected but not loaded */
  missing: string[];
  /** Files that were loaded */
  loaded: InstructionLoadRecord[];
  /** Human-readable summary */
  summary: string;
}

export interface InstructionsVerifierConfig {
  /** State directory for persisting tracking data */
  stateDir: string;
  /**
   * Patterns that MUST match at least one loaded file path.
   * Uses substring matching (not regex) for simplicity.
   * Default: ['CLAUDE.md'] — at minimum, the project CLAUDE.md should load.
   */
  expectedPatterns?: string[];
}

// ── Implementation ─────────────────────────────────────────────────

const DEFAULT_EXPECTED = ['CLAUDE.md'];

export class InstructionsVerifier {
  private config: InstructionsVerifierConfig;
  private trackingDir: string;

  constructor(config: InstructionsVerifierConfig) {
    this.config = config;
    this.trackingDir = path.join(config.stateDir, 'instructions-tracking');
    if (!fs.existsSync(this.trackingDir)) {
      fs.mkdirSync(this.trackingDir, { recursive: true });
    }
  }

  /**
   * Record an instruction file load. Called from the InstructionsLoaded hook.
   */
  recordLoad(record: Omit<InstructionLoadRecord, 'timestamp'>): void {
    const entry: InstructionLoadRecord = {
      timestamp: new Date().toISOString(),
      ...record,
    };
    const file = this.getTrackingFile(record.sessionId);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  }

  /**
   * Get all recorded loads for a session.
   */
  getLoads(sessionId?: string): InstructionLoadRecord[] {
    const file = this.getTrackingFile(sessionId);
    if (!fs.existsSync(file)) return [];

    return fs.readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter((r): r is InstructionLoadRecord => r !== null);
  }

  /**
   * Verify that expected instruction files were loaded.
   * Call this from the session-start hook after InstructionsLoaded events fire.
   */
  verify(sessionId?: string): VerificationResult {
    const loaded = this.getLoads(sessionId);
    const expectedPatterns = this.config.expectedPatterns ?? DEFAULT_EXPECTED;
    const loadedPaths = loaded.map(r => r.filePath);

    const missing: string[] = [];
    for (const pattern of expectedPatterns) {
      const found = loadedPaths.some(p => p.includes(pattern));
      if (!found) {
        missing.push(pattern);
      }
    }

    const passed = missing.length === 0;
    const summary = passed
      ? `All ${expectedPatterns.length} expected instruction file(s) loaded (${loaded.length} total files).`
      : `MISSING INSTRUCTIONS: ${missing.join(', ')} not found in ${loaded.length} loaded file(s). ` +
        `Loaded: ${loadedPaths.length > 0 ? loadedPaths.join(', ') : 'none'}`;

    return { passed, missing, loaded, summary };
  }

  /**
   * Clear tracking data for a session (e.g., on session restart).
   */
  clearSession(sessionId?: string): void {
    const file = this.getTrackingFile(sessionId);
    if (fs.existsSync(file)) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(file);
    }
  }

  /**
   * List all sessions with tracking data.
   */
  listSessions(): string[] {
    try {
      return fs.readdirSync(this.trackingDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort();
    } catch {
      return [];
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  private getTrackingFile(sessionId?: string): string {
    const safe = (sessionId ?? 'current')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 100);
    return path.join(this.trackingDir, `${safe}.jsonl`);
  }
}
