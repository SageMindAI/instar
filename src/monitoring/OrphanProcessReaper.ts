/**
 * OrphanProcessReaper — Detect and clean up orphaned Claude processes.
 *
 * Addresses the critical gap where Claude processes spawned outside
 * SessionManager (setup-wizard, login flow, corrupted state) are invisible
 * to the watchdog and accumulate indefinitely.
 *
 * Classification strategy:
 *   1. "tracked" — In a tmux session managed by SessionManager → leave alone
 *   2. "instar-orphan" — In a tmux session matching project naming but not tracked → auto-clean
 *   3. "external" — Not in a project-prefixed tmux session (user's own Claude, VS Code, etc.) → report only
 *
 * Safety: NEVER auto-kills user Claude sessions outside Instar.
 * External processes are only reported via Telegram for user decision.
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SessionManager } from '../core/SessionManager.js';
import type { InstarConfig } from '../core/types.js';

/** Drop-in replacement for execSync that avoids its security concerns. */
function shellExec(cmd: string, timeout = 5000): string {
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  rssKB: number;       // Resident Set Size in KB
  elapsedMs: number;   // How long it's been running
  command: string;      // Full command line
  tmuxSession: string | null;  // Which tmux session it belongs to (if any)
}

export type ProcessClassification = 'tracked' | 'instar-orphan' | 'external';

export interface ClassifiedProcess extends ClaudeProcess {
  classification: ProcessClassification;
  reason: string;
}

export interface ReaperReport {
  timestamp: string;
  tracked: ClassifiedProcess[];
  orphans: ClassifiedProcess[];
  external: ClassifiedProcess[];
  totalMemoryMB: number;
  orphanMemoryMB: number;
  externalMemoryMB: number;
  actionsPerformed: string[];
}

export interface OrphanReaperConfig {
  /** Poll interval in ms (default: 60000 — 1 minute) */
  pollIntervalMs?: number;
  /** Max age in ms before an orphan is auto-killed (default: 3600000 — 1 hour) */
  orphanMaxAgeMs?: number;
  /** Max age in ms before external processes are reported (default: 14400000 — 4 hours) */
  externalReportAgeMs?: number;
  /** Per-process RSS threshold in MB to flag as high-memory (default: 500) */
  highMemoryThresholdMB?: number;
  /** Whether to auto-kill instar orphans (default: true; false = report only) */
  autoKillOrphans?: boolean;
  /** Whether to report external (non-instar) Claude processes to the user (default: true) */
  reportExternalProcesses?: boolean;
  /** Callback to send alerts (e.g., Telegram) */
  alertCallback?: (message: string) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL = 60_000;       // 1 minute
const DEFAULT_ORPHAN_MAX_AGE = 3_600_000;   // 1 hour
const DEFAULT_EXTERNAL_REPORT_AGE = 14_400_000; // 4 hours
const DEFAULT_HIGH_MEMORY_MB = 500;

export class OrphanProcessReaper extends EventEmitter {
  private config: InstarConfig;
  private reaperConfig: OrphanReaperConfig;
  private sessionManager: SessionManager;
  private interval: ReturnType<typeof setInterval> | null = null;
  private projectPrefix: string;
  private lastReport: ReaperReport | null = null;
  private reportedExternalPids = new Set<number>(); // Don't spam about same PIDs
  private lastExternalAlertTime = 0; // Cooldown to avoid spamming about normal VS Code/terminal processes
  private static EXTERNAL_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

  constructor(
    config: InstarConfig,
    sessionManager: SessionManager,
    reaperConfig: OrphanReaperConfig = {},
  ) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
    this.reaperConfig = reaperConfig;
    // Project prefix used in tmux session naming (e.g., "the-portal-")
    this.projectPrefix = `${config.projectName}-`;
  }

  start(): void {
    if (this.interval) return;
    const pollMs = this.reaperConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    console.log(`[OrphanReaper] Starting (poll: ${pollMs / 1000}s, orphan max age: ${(this.reaperConfig.orphanMaxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE) / 60000}m)`);
    this.interval = setInterval(() => this.poll(), pollMs);
    // First check after 10 seconds (let other systems initialize)
    setTimeout(() => this.poll(), 10_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getLastReport(): ReaperReport | null {
    return this.lastReport;
  }

  /**
   * Run a scan immediately and return the report.
   * Can be called on-demand via API endpoints.
   */
  async scan(): Promise<ReaperReport> {
    return this.poll();
  }

  // ── Core Poll ──────────────────────────────────────────────────────

  private async poll(): Promise<ReaperReport> {
    const claudeProcesses = this.findAllClaudeProcesses();
    const tmuxSessions = this.listAllTmuxSessions();
    const trackedSessions = this.getTrackedSessionNames();

    const classified = this.classifyProcesses(claudeProcesses, tmuxSessions, trackedSessions);

    const tracked = classified.filter(p => p.classification === 'tracked');
    const orphans = classified.filter(p => p.classification === 'instar-orphan');
    const external = classified.filter(p => p.classification === 'external');

    const report: ReaperReport = {
      timestamp: new Date().toISOString(),
      tracked,
      orphans,
      external,
      totalMemoryMB: Math.round(classified.reduce((sum, p) => sum + p.rssKB, 0) / 1024),
      orphanMemoryMB: Math.round(orphans.reduce((sum, p) => sum + p.rssKB, 0) / 1024),
      externalMemoryMB: Math.round(external.reduce((sum, p) => sum + p.rssKB, 0) / 1024),
      actionsPerformed: [],
    };

    // Handle orphans
    const orphanMaxAge = this.reaperConfig.orphanMaxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE;
    const autoKill = this.reaperConfig.autoKillOrphans !== false; // default true

    for (const orphan of orphans) {
      if (orphan.elapsedMs > orphanMaxAge && autoKill) {
        this.killProcess(orphan.pid);
        // Also kill the tmux session if it exists
        if (orphan.tmuxSession) {
          this.killTmuxSession(orphan.tmuxSession);
        }
        const msg = `Killed orphan PID ${orphan.pid} (${Math.round(orphan.rssKB / 1024)}MB, running ${this.formatDuration(orphan.elapsedMs)}, tmux: ${orphan.tmuxSession || 'none'})`;
        report.actionsPerformed.push(msg);
        console.log(`[OrphanReaper] ${msg}`);
      }
    }

    // Report high-memory or old external processes (but don't auto-kill)
    const externalReportAge = this.reaperConfig.externalReportAgeMs ?? DEFAULT_EXTERNAL_REPORT_AGE;
    const highMemMB = this.reaperConfig.highMemoryThresholdMB ?? DEFAULT_HIGH_MEMORY_MB;
    const alertCallback = this.reaperConfig.alertCallback;

    const newExternalAlerts: ClassifiedProcess[] = [];
    for (const ext of external) {
      const isOld = ext.elapsedMs > externalReportAge;
      const isHighMem = ext.rssKB / 1024 > highMemMB;
      const alreadyReported = this.reportedExternalPids.has(ext.pid);

      if ((isOld || isHighMem) && !alreadyReported) {
        newExternalAlerts.push(ext);
        this.reportedExternalPids.add(ext.pid);
      }
    }

    // Clean up reported PIDs for processes that no longer exist
    for (const pid of this.reportedExternalPids) {
      if (!external.some(p => p.pid === pid)) {
        this.reportedExternalPids.delete(pid);
      }
    }

    // Send alert about external processes if any are notable.
    // Cooldown: only alert once per 24h — external processes are usually normal
    // (VS Code, terminal sessions) and constant alerts are noise.
    const reportExternal = this.reaperConfig.reportExternalProcesses !== false;
    const now = Date.now();
    const externalAlertCooledDown = now - this.lastExternalAlertTime > OrphanProcessReaper.EXTERNAL_ALERT_COOLDOWN_MS;
    if (reportExternal && newExternalAlerts.length > 0 && alertCallback && externalAlertCooledDown) {
      const totalExternal = external.length;
      const totalMemMB = Math.round(external.reduce((sum, p) => sum + p.rssKB, 0) / 1024);
      const processWord = totalExternal === 1 ? 'process' : 'processes';
      const msg = `Found ${totalExternal} Claude ${processWord} running outside your agent (using ${totalMemMB}MB of memory). This is usually from VS Code or a terminal session you have open — no action needed if that's the case.\n\nIf you're not actively using Claude elsewhere, reply "clean processes" to free up the memory.`;

      try {
        await alertCallback(msg);
        this.lastExternalAlertTime = now;
        report.actionsPerformed.push(`Reported ${totalExternal} external process(es) to user`);
      } catch (err) {
        console.error('[OrphanReaper] Failed to send alert:', err);
      }
    }

    // Alert about orphan kills
    if (report.actionsPerformed.length > 0 && alertCallback) {
      const orphanKills = report.actionsPerformed.filter(a => a.startsWith('Killed orphan'));
      if (orphanKills.length > 0) {
        const processWord = orphanKills.length === 1 ? 'process' : 'processes';
        const msg = `Cleaned up ${orphanKills.length} orphaned ${processWord} that were left over from previous agent sessions, freeing ~${report.orphanMemoryMB}MB of memory. No action needed — this is automatic maintenance.`;
        try {
          await alertCallback(msg);
        } catch (err) {
          console.error('[OrphanReaper] Failed to send orphan alert:', err);
        }
      }
    }

    this.lastReport = report;
    this.emit('scan', report);
    return report;
  }

  // ── Process Discovery ──────────────────────────────────────────────

  /**
   * Find ALL Claude processes owned by the current user.
   * Uses `ps` to get PID, PPID, RSS, elapsed time, and command.
   */
  private findAllClaudeProcesses(): ClaudeProcess[] {
    try {
      // Find all processes named "claude" owned by current user
      // Use ps with custom format for reliable parsing
      const uid = process.getuid?.() ?? 0;
      const output = shellExec(
        `ps -u ${uid} -o pid=,ppid=,rss=,etime=,command= 2>/dev/null | grep -i '[c]laude' | grep -v grep`,
        10_000,
      ).trim();

      if (!output) return [];

      const processes: ClaudeProcess[] = [];
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/);
        if (!match) continue;

        const pid = parseInt(match[1], 10);
        const ppid = parseInt(match[2], 10);
        const rssKB = parseInt(match[3], 10);
        const elapsed = this.parseElapsed(match[4]);
        const command = match[5];

        // Skip the instar server process itself
        if (command.includes('instar') && command.includes('server')) continue;

        // Only count actual Claude Code processes (not helpers, MCP servers, etc.)
        if (!this.isClaudeCodeProcess(command)) continue;

        processes.push({
          pid,
          ppid,
          rssKB,
          elapsedMs: elapsed,
          command: command.slice(0, 300),
          tmuxSession: null, // Will be resolved in classification
        });
      }

      return processes;
    } catch { // @silent-fallback-ok — process listing may fail if ps is unavailable
      return [];
    }
  }

  /**
   * Determine if a command is an actual Claude Code session (not an MCP server, etc.)
   */
  private isClaudeCodeProcess(command: string): boolean {
    // Actual Claude Code CLI invocations
    if (command.includes('claude') && !command.includes('claude-')) {
      // Exclude MCP servers, helpers, etc.
      const exclusions = [
        'claude-in-chrome', 'claude-mcp', 'playwright-mcp',
        'mcp-remote', 'exa-mcp', 'payments-mcp',
      ];
      return !exclusions.some(e => command.includes(e));
    }
    // node running Claude Code
    if (command.includes('node') && command.includes('claude')) {
      return true;
    }
    return false;
  }

  /**
   * List all tmux sessions and map pane PIDs to session names.
   */
  private listAllTmuxSessions(): Map<number, string> {
    const pidToSession = new Map<number, string>();
    try {
      const output = shellExec(
        `${this.config.sessions.tmuxPath} list-panes -a -F "#{session_name}||#{pane_pid}" 2>/dev/null`,
      ).trim();

      if (!output) return pidToSession;

      for (const line of output.split('\n')) {
        const [sessionName, pidStr] = line.split('||');
        if (sessionName && pidStr) {
          const pid = parseInt(pidStr, 10);
          if (!isNaN(pid)) {
            pidToSession.set(pid, sessionName);
          }
        }
      }
    } catch {
      // tmux not running or no sessions
    }
    return pidToSession;
  }

  /**
   * Get tmux session names tracked by SessionManager.
   */
  private getTrackedSessionNames(): Set<string> {
    const running = this.sessionManager.listRunningSessions();
    return new Set(running.map(s => s.tmuxSession));
  }

  // ── Classification ─────────────────────────────────────────────────

  /**
   * Classify each Claude process:
   *   - tracked: In a tmux session managed by SessionManager
   *   - instar-orphan: In a project-prefixed tmux session NOT tracked by SessionManager
   *   - external: Everything else (user sessions, VS Code, etc.)
   */
  private classifyProcesses(
    processes: ClaudeProcess[],
    tmuxSessions: Map<number, string>,
    trackedSessions: Set<string>,
  ): ClassifiedProcess[] {
    return processes.map(proc => {
      // Resolve which tmux session this process belongs to
      // Check if this PID or its parent is a tmux pane
      const directSession = tmuxSessions.get(proc.pid);
      const parentSession = tmuxSessions.get(proc.ppid);
      // Also check grandparent — Claude spawns under node which is under tmux pane
      const grandparentPid = this.getParentPid(proc.ppid);
      const grandparentSession = grandparentPid ? tmuxSessions.get(grandparentPid) : null;

      const tmuxSession = directSession || parentSession || grandparentSession || null;
      proc.tmuxSession = tmuxSession;

      if (tmuxSession) {
        // In a tmux session — is it tracked?
        if (trackedSessions.has(tmuxSession)) {
          return {
            ...proc,
            classification: 'tracked' as const,
            reason: `Managed by SessionManager in tmux "${tmuxSession}"`,
          };
        }

        // In a tmux session matching our project prefix but NOT tracked
        if (tmuxSession.startsWith(this.projectPrefix)) {
          return {
            ...proc,
            classification: 'instar-orphan' as const,
            reason: `In project-prefixed tmux "${tmuxSession}" but not tracked by SessionManager`,
          };
        }

        // In some other tmux session — likely user's own
        return {
          ...proc,
          classification: 'external' as const,
          reason: `In tmux session "${tmuxSession}" (not project-prefixed)`,
        };
      }

      // Not in any tmux session — could be VS Code, terminal, or spawn()-based orphan
      const parentCommand = this.getProcessCommand(proc.ppid);

      // VS Code spawns Claude via its integrated terminal
      if (parentCommand && (
        parentCommand.includes('code') ||
        parentCommand.includes('Code Helper') ||
        parentCommand.includes('Electron') ||
        parentCommand.includes('cursor') ||
        parentCommand.includes('windsurf')
      )) {
        return {
          ...proc,
          classification: 'external' as const,
          reason: `Spawned by IDE (parent: ${parentCommand.slice(0, 80)})`,
        };
      }

      // Terminal.app, iTerm, Warp, etc.
      if (parentCommand && (
        parentCommand.includes('Terminal') ||
        parentCommand.includes('iTerm') ||
        parentCommand.includes('Warp') ||
        parentCommand.includes('Alacritty') ||
        parentCommand.includes('kitty') ||
        parentCommand.includes('zsh') ||
        parentCommand.includes('bash')
      )) {
        return {
          ...proc,
          classification: 'external' as const,
          reason: `Spawned by terminal (parent: ${parentCommand.slice(0, 80)})`,
        };
      }

      // Non-tmux, non-IDE process — might be a spawn() orphan from Instar
      // (e.g., setup-wizard). If it's old, classify as orphan.
      const orphanAge = this.reaperConfig.orphanMaxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE;
      if (proc.elapsedMs > orphanAge) {
        return {
          ...proc,
          classification: 'external' as const,
          reason: `Non-tmux process with unknown parent (pid ${proc.ppid}: ${(parentCommand || 'unknown').slice(0, 60)}). Old but cannot confirm Instar origin — reporting as external for safety.`,
        };
      }

      // Recent non-tmux process — assume external (user just started it)
      return {
        ...proc,
        classification: 'external' as const,
        reason: `Non-tmux process, parent: ${(parentCommand || 'unknown').slice(0, 80)}`,
      };
    });
  }

  // ── Process Utilities ──────────────────────────────────────────────

  private getParentPid(pid: number): number | null {
    try {
      const output = shellExec(`ps -o ppid= -p ${pid} 2>/dev/null`).trim();
      const ppid = parseInt(output, 10);
      return isNaN(ppid) ? null : ppid;
    } catch { // @silent-fallback-ok — process may not exist
      return null;
    }
  }

  private getProcessCommand(pid: number): string | null {
    try {
      const output = shellExec(`ps -o command= -p ${pid} 2>/dev/null`).trim();
      return output || null;
    } catch { // @silent-fallback-ok — process may not exist
      return null;
    }
  }

  private killProcess(pid: number): boolean {
    try {
      process.kill(pid, 'SIGTERM');
      // Give it 5 seconds, then SIGKILL if needed
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Check if still alive
          process.kill(pid, 'SIGKILL');
          console.log(`[OrphanReaper] SIGKILL sent to PID ${pid} (SIGTERM wasn't enough)`);
        } catch { // @silent-fallback-ok — process already dead (expected)
          // Already dead — good
        }
      }, 5000);
      return true;
    } catch (err: any) { // @silent-fallback-ok — kill may fail if process already exited
      if (err.code !== 'ESRCH') {
        console.error(`[OrphanReaper] Failed to kill PID ${pid}:`, err);
      }
      return false;
    }
  }

  private killTmuxSession(sessionName: string): void {
    try {
      shellExec(`${this.config.sessions.tmuxPath} kill-session -t "=${sessionName}" 2>/dev/null`);
    } catch {
      // Already dead
    }
  }

  /**
   * Manually kill an external process by PID.
   * Called via user command (e.g., "clean 12345").
   */
  killExternalProcess(pid: number): { success: boolean; message: string } {
    const report = this.lastReport;
    if (!report) {
      return { success: false, message: 'No scan report available. Run a scan first.' };
    }

    const process = report.external.find(p => p.pid === pid);
    if (!process) {
      return { success: false, message: `PID ${pid} is not in the external process list.` };
    }

    const killed = this.killProcess(pid);
    if (process.tmuxSession) {
      this.killTmuxSession(process.tmuxSession);
    }

    return {
      success: killed,
      message: killed
        ? `Killed PID ${pid} (${Math.round(process.rssKB / 1024)}MB, ${process.reason})`
        : `Failed to kill PID ${pid}`,
    };
  }

  /**
   * Kill all external processes. User-initiated only.
   */
  killAllExternal(): { killed: number; freedMB: number; details: string[] } {
    const report = this.lastReport;
    if (!report) {
      return { killed: 0, freedMB: 0, details: ['No scan report available.'] };
    }

    const details: string[] = [];
    let freedKB = 0;

    for (const proc of report.external) {
      const killed = this.killProcess(proc.pid);
      if (proc.tmuxSession) {
        this.killTmuxSession(proc.tmuxSession);
      }
      if (killed) {
        freedKB += proc.rssKB;
        details.push(`Killed PID ${proc.pid} (${Math.round(proc.rssKB / 1024)}MB)`);
      }
    }

    return {
      killed: details.length,
      freedMB: Math.round(freedKB / 1024),
      details,
    };
  }

  // ── Parsing Utilities ──────────────────────────────────────────────

  private parseElapsed(elapsed: string): number {
    // Format: [[DD-]HH:]MM:SS or just MM:SS
    let days = 0;
    let timePart = elapsed;
    if (elapsed.includes('-')) {
      const [d, t] = elapsed.split('-');
      days = parseInt(d, 10);
      timePart = t;
    }
    const parts = timePart.split(':').map(Number);
    let seconds = 0;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
    else seconds = parts[0];
    return (days * 86400 + seconds) * 1000;
  }

  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}
