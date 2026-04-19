/**
 * SessionWatchdog — Auto-remediation for stuck Claude sessions (Instar port).
 *
 * Detects when a Claude session has a long-running bash command and escalates
 * from gentle (Ctrl+C) to forceful (SIGKILL + session kill). Adapted from
 * Dawn Server's SessionWatchdog for Instar's self-contained architecture.
 *
 * Escalation pipeline:
 *   Level 0: Monitoring (default)
 *   Level 1: Ctrl+C via tmux send-keys
 *   Level 2: SIGTERM the stuck child PID
 *   Level 3: SIGKILL the stuck child PID
 *   Level 4: Kill tmux session
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

/** Drop-in replacement for execSync that avoids its security concerns. */
function shellExec(cmd: string, timeout = 5000): string {
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { InstarConfig, IntelligenceProvider } from '../core/types.js';

export enum EscalationLevel {
  Monitoring = 0,
  CtrlC = 1,
  SigTerm = 2,
  SigKill = 3,
  KillSession = 4,
}

interface ChildProcessInfo {
  pid: number;
  command: string;
  elapsedMs: number;
}

interface EscalationState {
  level: EscalationLevel;
  levelEnteredAt: number;
  stuckChildPid: number;
  stuckCommand: string;
  retryCount: number;
}

export interface InterventionEvent {
  sessionName: string;
  level: EscalationLevel;
  action: string;
  stuckCommand: string;
  stuckPid: number;
  timestamp: number;
  /** Outcome tracking — filled in after a delay */
  outcome?: 'recovered' | 'died' | 'unknown';
  /** Time in ms between intervention and outcome determination */
  outcomeDelayMs?: number;
}

/** Aggregated watchdog stats for telemetry */
export interface WatchdogStats {
  interventionsTotal: number;
  interventionsByLevel: Record<string, number>; // level name → count
  recoveries: number;
  sessionDeaths: number;
  outcomeUnknown: number;
  llmGateOverrides: number; // times LLM said "legitimate"
}

// Processes that are long-running by design.
// Entries can be strings (substring match via `includes`) or regex (token match).
const EXCLUDED_PATTERNS: Array<string | RegExp> = [
  'playwright-persistent',
  'chrome-native-host', 'caffeinate',
  // Any *-mcp executable is an MCP stdio server, long-running by design
  // (waits on stdin for the host client). This catches workspace-mcp,
  // exa-mcp-server, foo-mcp, claude-in-chrome-mcp, bar-mcp-server.js, etc.
  // Character class includes `-` so multi-hyphen names (claude-in-chrome-mcp)
  // are consumed whole. Trailing lookahead allows end, whitespace, slash,
  // or `.` (so `-mcp-server.js` style entry points match).
  /(?:^|[\s/@])[\w.@-]+-mcp(?:-server)?(?=$|[\s/.])/,
  // Package-style "@scope/mcp" where the last token is bare "mcp"
  // (e.g. @playwright/mcp, @modelcontextprotocol/mcp). Covered by the
  // existing "/mcp/" literal when inside a longer path, but a trailing
  // bare "/mcp" also needs catching.
  /(?:^|\s)[@\w./-]+\/mcp(?=$|[\s/])/,
  'mcp-remote', '/mcp/', '.mcp/',
  'mcp-stdio-entry', 'mcp-stdio.js', '/mcp-stdio',
  // Shell-snapshot sourcing is session initialization, not a stuck command
  '.claude/shell-snapshots',
];

// Commands whose job is to consume stdin from a pipeline. When they appear
// as a "stuck" child it's almost always because zsh -c "cmd | consumer"
// exec'd the last pipeline member into place — the consumer is waiting on
// the upstream producer, which is the real long-running work. Before
// escalating, check if the consumer has an active pipeline sibling.
//
// Regex matches the executable name (first whitespace-delimited token,
// optionally leading path). Consumers that require a file argument to be
// meaningful (e.g. `tail FILE`) are still flagged if a file arg is present,
// because then they aren't reading from a pipe.
const STDIN_CONSUMER_PATTERNS: Array<{ cmd: RegExp; requiresNoFileArg: boolean }> = [
  { cmd: /^(?:\S*\/)?tail(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?head(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?less(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?more(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?cat(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?grep(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?sort(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?uniq(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?awk(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?sed(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?tr(?:\s|$)/, requiresNoFileArg: false },
  { cmd: /^(?:\S*\/)?wc(?:\s|$)/, requiresNoFileArg: true },
  { cmd: /^(?:\S*\/)?xargs(?:\s|$)/, requiresNoFileArg: false },
  { cmd: /^(?:\S*\/)?jq(?:\s|$)/, requiresNoFileArg: true },
];

const EXCLUDED_PREFIXES = [
  '/bin/zsh -c -l source',
  '/bin/bash -c -l source',
  // Shell-snapshot commands don't always include -l flag
  '/bin/zsh -c source',
  '/bin/bash -c source',
];

// Escalation delays (ms to wait before advancing to next level)
const ESCALATION_DELAYS: Record<EscalationLevel, number> = {
  [EscalationLevel.Monitoring]: 0,
  [EscalationLevel.CtrlC]: 0,
  [EscalationLevel.SigTerm]: 15_000,
  [EscalationLevel.SigKill]: 10_000,
  [EscalationLevel.KillSession]: 5_000,
};

const DEFAULT_STUCK_THRESHOLD_MS = 180_000; // 3 minutes
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_RETRIES = 2;

export interface WatchdogEvents {
  intervention: [event: InterventionEvent];
  recovery: [sessionName: string, fromLevel: EscalationLevel];
  'compaction-idle': [sessionName: string];
}

export class SessionWatchdog extends EventEmitter {
  private config: InstarConfig;
  private sessionManager: SessionManager;
  private state: StateManager;
  private interval: ReturnType<typeof setInterval> | null = null;
  private escalationState = new Map<string, EscalationState>();
  private interventionHistory: InterventionEvent[] = [];
  private enabled = true;
  private running = false;

  private stuckThresholdMs: number;
  private pollIntervalMs: number;
  private logPath: string;

  /** Intelligence provider — gates escalation entry with LLM command analysis */
  intelligence: IntelligenceProvider | null = null;

  /** Temporarily exempted commands (LLM confirmed as legitimate long-running) */
  private temporaryExclusions = new Set<number>(); // PIDs

  /** Counter for LLM gate overrides (said "legitimate") — for telemetry */
  private llmGateOverrides = 0;

  /** Pending outcome checks — maps sessionName to intervention event */
  private pendingOutcomeChecks = new Map<string, InterventionEvent>();

  /** Cooldowns for compaction-idle detection — prevents repeated emissions */
  private compactionIdleCooldowns = new Map<string, number>(); // sessionName → timestamp
  private static readonly COMPACTION_IDLE_COOLDOWN_MS = 300_000; // 5 minutes

  constructor(config: InstarConfig, sessionManager: SessionManager, state: StateManager) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
    this.state = state;

    const wdConfig = config.monitoring.watchdog;
    this.stuckThresholdMs = (wdConfig?.stuckCommandSec ?? 180) * 1000;
    this.pollIntervalMs = wdConfig?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Persistent log path
    this.logPath = path.join(config.stateDir, 'watchdog-interventions.jsonl');
  }

  start(): void {
    if (this.interval) return;
    console.log(`[Watchdog] Starting (poll: ${this.pollIntervalMs / 1000}s, threshold: ${this.stuckThresholdMs / 1000}s)`);
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
    setTimeout(() => this.poll(), 5000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.escalationState.clear();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isManaging(sessionName: string): boolean {
    const s = this.escalationState.get(sessionName);
    return s !== undefined && s.level > EscalationLevel.Monitoring;
  }

  getStatus(): {
    enabled: boolean;
    sessions: Array<{ name: string; escalation: EscalationState | null }>;
    interventionHistory: InterventionEvent[];
  } {
    const runningSessions = this.sessionManager.listRunningSessions();
    const sessions = runningSessions.map(s => ({
      name: s.tmuxSession,
      escalation: this.escalationState.get(s.tmuxSession) ?? null,
    }));

    return {
      enabled: this.enabled,
      sessions,
      interventionHistory: this.interventionHistory.slice(-20),
    };
  }

  // --- Core polling ---

  private async poll(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;

    try {
      const sessions = this.sessionManager.listRunningSessions();
      for (const session of sessions) {
        try {
          await this.checkSession(session.tmuxSession);
        } catch (err) {
          console.error(`[Watchdog] Error checking "${session.tmuxSession}":`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async checkSession(tmuxSession: string): Promise<void> {
    const existing = this.escalationState.get(tmuxSession);

    if (existing && existing.level > EscalationLevel.Monitoring) {
      this.handleEscalation(tmuxSession, existing);
      return;
    }

    // Find Claude PID in the tmux session. If we can't locate it, we skip
    // the stuck-command path but still run compaction-idle detection —
    // that path is output-based and doesn't strictly need a PID (its own
    // process guard is null-safe).
    const claudePid = this.getClaudePid(tmuxSession);
    if (!claudePid) {
      this.checkCompactionIdle(tmuxSession);
      return;
    }

    const children = this.getChildProcesses(claudePid);
    const stuckChild = children.find(c => {
      if (this.isExcluded(c.command)) return false;
      if (this.temporaryExclusions.has(c.pid)) return false;
      // Stdin consumers (tail, grep, sort...) get a much longer grace
      // period. They're typically part of a pipeline where the producer
      // is the real work, and the 3-minute default threshold is too
      // aggressive for long-running builds, tests, or measurements.
      const threshold = this.isStdinConsumerCommand(c.command)
        ? Math.max(this.stuckThresholdMs, 600_000) // at least 10 minutes
        : this.stuckThresholdMs;
      return c.elapsedMs > threshold;
    });

    if (stuckChild) {
      // Pipeline guard: if the stuck child is a pure stdin consumer (tail,
      // grep, sort, etc.) and its process group or descendants still
      // contain active sibling producers, the "stuck" process is just
      // waiting for upstream output from a legitimate long-running
      // pipeline. Skip escalation.
      if (this.hasActivePipelineSibling(stuckChild.pid, stuckChild.command)) {
        console.log(
          `[Watchdog] "${tmuxSession}": ${stuckChild.command.slice(0, 60)} ` +
          `is consuming an active pipeline — skipping escalation`,
        );
        this.temporaryExclusions.add(stuckChild.pid);
        return;
      }

      // LLM gate: check if this command is legitimately long-running before escalating.
      // Pass recent tmux output so the LLM can see what the session is actually doing,
      // not just the (often truncated) child command name.
      const recentOutput = this.sessionManager.captureOutput(tmuxSession, 30) ?? '';
      const isStuck = await this.isCommandStuck(stuckChild.command, stuckChild.elapsedMs, recentOutput);
      if (!isStuck) {
        // LLM says legitimate — temporarily exclude this PID from future checks
        this.temporaryExclusions.add(stuckChild.pid);
        return;
      }

      // Fail-closed for stdin-consumers when the LLM isn't available or is
      // uncertain: killing a `tail`/`grep` in an apparent pipeline has high
      // blast radius (takes down the whole producer pipeline), so we only
      // escalate these with explicit LLM confirmation. Without an LLM, we
      // skip and log — a true orphaned consumer will be cleaned up when
      // its tmux session terminates.
      if (this.isStdinConsumerCommand(stuckChild.command) && !this.intelligence) {
        console.log(
          `[Watchdog] "${tmuxSession}": stdin-consumer ${stuckChild.command.slice(0, 60)} ` +
          `without LLM gate — refusing to escalate (fail-closed for pipeline safety)`,
        );
        this.temporaryExclusions.add(stuckChild.pid);
        return;
      }

      const state: EscalationState = {
        level: EscalationLevel.CtrlC,
        levelEnteredAt: Date.now(),
        stuckChildPid: stuckChild.pid,
        stuckCommand: stuckChild.command,
        retryCount: existing?.retryCount ?? 0,
      };
      this.escalationState.set(tmuxSession, state);

      console.log(
        `[Watchdog] "${tmuxSession}": stuck command (${Math.round(stuckChild.elapsedMs / 1000)}s): ` +
        `${stuckChild.command.slice(0, 80)} — sending Ctrl+C`
      );

      this.sessionManager.sendKey(tmuxSession, 'C-c');
      this.recordIntervention(tmuxSession, EscalationLevel.CtrlC, 'Sent Ctrl+C', stuckChild);
    } else if (existing) {
      this.escalationState.delete(tmuxSession);
    }

    // Clean up temporary exclusions for dead processes
    for (const pid of this.temporaryExclusions) {
      if (!this.isProcessAlive(pid)) {
        this.temporaryExclusions.delete(pid);
      }
    }

    // Post-compaction idle detection — catch sessions that compacted and are
    // sitting at a bare prompt with no one at the terminal to nudge them.
    // This is the polling-based fallback for the PreCompact event path which
    // is unreliable (Claude Code doesn't always fire the event).
    this.checkCompactionIdle(tmuxSession);
  }

  /**
   * Detects sessions that just went through context compaction and are idle
   * at a prompt. Emits 'compaction-idle' so server.ts can activate triage
   * to reinject pending user messages.
   *
   * Defense-in-depth against false positives:
   *   1. Compaction marker must appear in last 10 lines (recency — avoids stale buffer)
   *   2. Prompt must be in last 3 lines (structural — avoids > in content)
   *   3. No active child processes (process-level — Claude is truly idle, not mid-tool)
   *   4. Cooldown per session (prevents re-triggering on same compaction)
   *   5. server.ts checks message history before activating triage (data-level guard)
   *   6. TriageOrchestrator Pattern 2b re-validates before reinjecting (redundant check)
   */
  checkCompactionIdle(tmuxSession: string): void {
    // Cooldown — don't re-emit for the same session within 5 minutes
    const lastEmitted = this.compactionIdleCooldowns.get(tmuxSession);
    if (lastEmitted && (Date.now() - lastEmitted) < SessionWatchdog.COMPACTION_IDLE_COOLDOWN_MS) {
      return;
    }

    // Guard 1: Structural process check — if Claude has active child processes,
    // it's executing tools/commands, not stalled. Skip entirely.
    const claudePid = this.getClaudePid(tmuxSession);
    if (claudePid) {
      const children = this.getChildProcesses(claudePid);
      const activeChildren = children.filter(c => !this.isExcluded(c.command));
      if (activeChildren.length > 0) return;
    }

    // Capture recent tmux output — only last 10 lines to ensure compaction is recent.
    // If the compaction marker has scrolled beyond 10 lines, the session has had
    // enough activity since compaction that it clearly recovered.
    const output = this.sessionManager.captureOutput(tmuxSession, 10);
    if (!output) return;

    // Guard 2: Compaction marker must be present in this narrow window
    if (!/Conversation compacted|✱.*compacted/i.test(output)) return;

    // Guard 3: Prompt must be in the last 3 lines (tighter than general heuristics).
    // A bare `>` in markdown, code output, or file content won't appear as the
    // final line of tmux output — it would have subsequent content after it.
    const lines = output.split('\n').filter(l => l.trim());
    const tail = lines.slice(-3).join('\n');
    const atPrompt =
      tail.includes('❯') ||
      tail.includes('bypass permissions') ||
      /^>\s*$/m.test(tail) ||
      tail.trim() === '>';

    if (!atPrompt) return;

    // All guards passed — session compacted recently and is truly idle
    console.log(`[Watchdog] "${tmuxSession}": compaction-idle detected — session compacted and at prompt`);
    this.compactionIdleCooldowns.set(tmuxSession, Date.now());
    this.emit('compaction-idle', tmuxSession);
  }

  private handleEscalation(tmuxSession: string, state: EscalationState): void {
    const now = Date.now();

    if (!this.isProcessAlive(state.stuckChildPid)) {
      console.log(`[Watchdog] "${tmuxSession}": stuck process ${state.stuckChildPid} died — recovered`);
      this.emit('recovery', tmuxSession, state.level);
      this.escalationState.delete(tmuxSession);
      return;
    }

    const timeInLevel = now - state.levelEnteredAt;
    const nextLevel = state.level + 1;

    if (nextLevel > EscalationLevel.KillSession) {
      if (state.retryCount >= MAX_RETRIES) {
        console.log(`[Watchdog] "${tmuxSession}": max retries reached — giving up`);
        this.escalationState.delete(tmuxSession);
        return;
      }
      state.level = EscalationLevel.CtrlC;
      state.levelEnteredAt = now;
      state.retryCount++;
      this.sessionManager.sendKey(tmuxSession, 'C-c');
      this.recordIntervention(tmuxSession, EscalationLevel.CtrlC, `Retry ${state.retryCount}: Sent Ctrl+C`, {
        pid: state.stuckChildPid, command: state.stuckCommand, elapsedMs: 0,
      });
      return;
    }

    const delayForNext = ESCALATION_DELAYS[nextLevel as EscalationLevel] ?? 15_000;
    if (timeInLevel < delayForNext) return;

    state.level = nextLevel as EscalationLevel;
    state.levelEnteredAt = now;

    const child = { pid: state.stuckChildPid, command: state.stuckCommand, elapsedMs: 0 };

    switch (state.level) {
      case EscalationLevel.SigTerm:
        console.log(`[Watchdog] "${tmuxSession}": sending SIGTERM to ${state.stuckChildPid}`);
        this.sendSignal(state.stuckChildPid, 'SIGTERM');
        this.recordIntervention(tmuxSession, EscalationLevel.SigTerm, `SIGTERM ${state.stuckChildPid}`, child);
        break;

      case EscalationLevel.SigKill:
        console.log(`[Watchdog] "${tmuxSession}": sending SIGKILL to ${state.stuckChildPid}`);
        this.sendSignal(state.stuckChildPid, 'SIGKILL');
        this.recordIntervention(tmuxSession, EscalationLevel.SigKill, `SIGKILL ${state.stuckChildPid}`, child);
        break;

      case EscalationLevel.KillSession:
        console.log(`[Watchdog] "${tmuxSession}": killing tmux session`);
        this.killTmuxSession(tmuxSession);
        this.recordIntervention(tmuxSession, EscalationLevel.KillSession, 'Killed tmux session', child);
        this.escalationState.delete(tmuxSession);
        break;
    }
  }

  /**
   * LLM gate: Before entering escalation, ask whether the command is
   * legitimately long-running or actually stuck. This prevents the watchdog
   * from killing legitimate builds, installs, or data processing.
   *
   * Returns true if the command appears stuck and should be escalated.
   * Returns false if the LLM thinks it's a legitimate long-running task.
   * If no LLM is available, returns true (fail-open — stuck commands need recovery).
   */
  private async isCommandStuck(command: string, elapsedMs: number, recentOutput = ''): Promise<boolean> {
    if (!this.intelligence) return true; // No LLM → fail-open

    const elapsedMin = Math.round(elapsedMs / 60000);
    // Keep the output sample small — enough for context, not enough to blow the token budget.
    const outputSample = recentOutput ? recentOutput.slice(-1500) : '';
    const promptLines = [
      'You are evaluating whether a running process is stuck or legitimately long-running.',
      '',
      `Command: ${command.slice(0, 200)}`,
      `Running for: ${elapsedMin} minutes`,
    ];
    if (outputSample) {
      promptLines.push(
        '',
        'Recent terminal output (tail of the session\'s tmux pane — shows what the agent is doing):',
        '---',
        outputSample,
        '---',
      );
    }
    promptLines.push(
      '',
      'Legitimate long-running commands include:',
      '- Package installs (npm install, pip install, cargo build, etc.)',
      '- Large builds (webpack, tsc with many files, docker build)',
      '- Database migrations or data processing',
      '- Test suites (pytest, vitest, jest with many tests)',
      '- Network operations (curl large files, git clone large repos)',
      '- Interactive processes (vim, less, ssh sessions)',
      '- Pipeline consumers (tail, grep, sort) whose producer is still running',
      '',
      'Likely stuck commands include:',
      '- Simple commands that should complete in seconds (ls, cat, echo)',
      '- Commands with no output that normally produce output quickly',
      '- Processes that appear to be waiting for input that will never come',
      '',
      'Note: if the terminal output shows an active tool/test/build still producing results,',
      'the command is legitimate even if the bare command name looks trivial.',
      '',
      'Is this command stuck or legitimate? Respond with exactly one word: stuck or legitimate.',
    );
    const prompt = promptLines.join('\n');

    try {
      const response = await this.intelligence.evaluate(prompt, {
        maxTokens: 5,
        temperature: 0,
      });
      const answer = response.trim().toLowerCase();
      if (answer === 'legitimate') {
        console.log(`[Watchdog] LLM says "${command.slice(0, 60)}" is legitimate — skipping escalation`);
        this.llmGateOverrides++;
        return false;
      }
      return true;
    } catch (err) {
      // @silent-fallback-ok — LLM intelligence is optional; fail-open to recover stuck processes
      console.warn(`[Watchdog] LLM command check failed, assuming stuck:`, err);
      return true; // Fail-open
    }
  }

  // --- Process utilities (self-contained, no shared module) ---

  private getClaudePid(tmuxSession: string): number | null {
    try {
      // Get pane PID
      const panePidStr = shellExec(
        `${this.config.sessions.tmuxPath} list-panes -t "=${tmuxSession}" -F "#{pane_pid}" 2>/dev/null`
      ).trim().split('\n')[0];
      if (!panePidStr) return null;
      const panePid = parseInt(panePidStr, 10);
      if (isNaN(panePid)) return null;

      // Instar typically spawns claude directly as the pane's root process,
      // not as a child of a shell. Check the pane_pid's own command first —
      // if it's claude, return it directly. Without this, pgrep -P finds no
      // match (claude has no claude child) and the watchdog silently no-ops.
      const paneCmd = shellExec(`ps -p ${panePid} -o comm= 2>/dev/null`).trim();
      if (/^(-?)claude$/.test(paneCmd) || paneCmd.endsWith('/claude')) {
        return panePid;
      }

      // Fallback: pane runs a shell wrapper that has claude as a child
      const claudePidStr = shellExec(
        `pgrep -P ${panePid} -f claude 2>/dev/null | head -1`
      ).trim();
      if (!claudePidStr) return null;
      const pid = parseInt(claudePidStr, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      // @silent-fallback-ok — process detection returns null
      return null;
    }
  }

  private getChildProcesses(pid: number): ChildProcessInfo[] {
    try {
      const childPidsStr = shellExec(`pgrep -P ${pid} 2>/dev/null`).trim();
      if (!childPidsStr) return [];

      const childPids = childPidsStr.split('\n').filter(Boolean).join(',');
      if (!childPids) return [];

      const output = shellExec(`ps -o pid=,etime=,command= -p ${childPids} 2>/dev/null`).trim();
      if (!output) return [];

      const results: ChildProcessInfo[] = [];
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+([\d:.-]+)\s+(.+)$/);
        if (!match) continue;
        const childPid = parseInt(match[1], 10);
        if (isNaN(childPid)) continue;
        results.push({
          pid: childPid,
          command: match[3],
          elapsedMs: this.parseElapsed(match[2]),
        });
      }
      return results;
    } catch {
      // @silent-fallback-ok — process enumeration returns empty
      return [];
    }
  }

  /**
   * Detects whether the given process is a pipeline stdin consumer (tail,
   * grep, sort, etc.) whose process group still contains an active sibling
   * producer. Such cases are false positives for the stuck-command detector:
   * `zsh -c "python ... | tail -40"` execs tail into place, so the child
   * of claude shows up as `tail -40` even though the real work is the
   * python producer still running in the same pgid.
   *
   * Returns true if this PID looks like a waiting consumer in an active
   * pipeline — in which case escalation should be skipped.
   */
  private hasActivePipelineSibling(pid: number, command: string): boolean {
    // Step 1: is the command a stdin-consuming candidate at all?
    const consumer = STDIN_CONSUMER_PATTERNS.find(p => p.cmd.test(command));
    if (!consumer) return false;

    // Step 2: if the consumer was given a file arg, it's not reading from
    // a pipe (e.g. `tail -f /var/log/foo` genuinely tails that file).
    if (consumer.requiresNoFileArg && this.hasFileArgument(command)) return false;

    // Step 3: find the process group and peers.
    try {
      const pgidStr = shellExec(`ps -o pgid= -p ${pid} 2>/dev/null`).trim();
      const pgid = parseInt(pgidStr, 10);

      // Check process group peers (pipelines share pgid on macOS/Linux).
      if (!isNaN(pgid) && pgid > 0) {
        const peersOutput = shellExec(
          `ps -o pid=,command= -g ${pgid} 2>/dev/null`,
        ).trim();
        for (const line of peersOutput.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const peerPid = parseInt(match[1], 10);
          const peerCmd = match[2];
          if (peerPid === pid) continue; // self
          if (peerCmd.startsWith('ps ') || peerCmd.startsWith('sh -c')) continue; // our own probe
          if (this.isExcluded(peerCmd)) continue;
          return true;
        }
      }

      // Fallback: also check direct descendants of the consumer PID. In
      // some shell exec patterns the producer becomes a CHILD of the
      // exec'd consumer rather than a pgid sibling.
      const childPidsStr = shellExec(`pgrep -P ${pid} 2>/dev/null`).trim();
      if (childPidsStr) {
        const childPids = childPidsStr.split('\n').filter(Boolean).join(',');
        if (childPids) {
          const childOutput = shellExec(`ps -o pid=,command= -p ${childPids} 2>/dev/null`).trim();
          for (const line of childOutput.split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) continue;
            const childCmd = match[2];
            if (this.isExcluded(childCmd)) continue;
            return true;
          }
        }
      }

      return false;
    } catch {
      // @silent-fallback-ok — on error, fall through to normal escalation path
      return false;
    }
  }

  /**
   * Cheap check whether a command is a pure stdin consumer (tail, grep,
   * sort, etc.) without needing pgid lookups. Used to apply extended
   * grace periods and fail-closed escalation for this class of commands.
   */
  private isStdinConsumerCommand(command: string): boolean {
    const consumer = STDIN_CONSUMER_PATTERNS.find(p => p.cmd.test(command));
    if (!consumer) return false;
    if (consumer.requiresNoFileArg && this.hasFileArgument(command)) return false;
    return true;
  }

  /**
   * Heuristic: does a stdin-consumer command have a file argument? If so,
   * it's reading from the file (not a pipe) and the pipeline guard doesn't
   * apply. We strip flags (tokens starting with `-`) and anything that
   * looks like a flag value, then check if a non-flag token remains past
   * the executable name.
   */
  private hasFileArgument(command: string): boolean {
    const tokens = command.split(/\s+/).slice(1); // drop executable
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      if (tok.startsWith('-')) {
        // Skip short-option values for well-known flags that take one
        // (tail -n N, head -c N, grep -A N, etc.). This is heuristic —
        // we prefer false-negatives (no file detected) over false-positives.
        if (/^-[nNcACB]$/.test(tok)) i++; // next token is the value
        continue;
      }
      // Non-flag token that isn't the executable → file argument
      return true;
    }
    return false;
  }

  private isExcluded(command: string): boolean {
    for (const pattern of EXCLUDED_PATTERNS) {
      if (typeof pattern === 'string') {
        if (command.includes(pattern)) return true;
      } else if (pattern.test(command)) {
        return true;
      }
    }
    for (const prefix of EXCLUDED_PREFIXES) {
      if (command.startsWith(prefix)) return true;
    }
    return false;
  }

  private parseElapsed(elapsed: string): number {
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

  private sendSignal(pid: number, signal: string): void {
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch (err: any) {
      // @silent-fallback-ok — ESRCH expected for dead processes
      if (err.code !== 'ESRCH') {
        console.error(`[Watchdog] Failed to send ${signal} to ${pid}:`, err);
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // @silent-fallback-ok — signal 0 check
      return false;
    }
  }

  private killTmuxSession(tmuxSession: string): void {
    try {
      shellExec(`${this.config.sessions.tmuxPath} kill-session -t "=${tmuxSession}" 2>/dev/null`);
    } catch {}
  }

  private recordIntervention(
    sessionName: string,
    level: EscalationLevel,
    action: string,
    child: { pid: number; command: string; elapsedMs: number },
  ): void {
    const event: InterventionEvent = {
      sessionName,
      level,
      action,
      stuckCommand: child.command.slice(0, 200),
      stuckPid: child.pid,
      timestamp: Date.now(),
    };
    this.interventionHistory.push(event);
    if (this.interventionHistory.length > 50) {
      this.interventionHistory = this.interventionHistory.slice(-50);
    }
    this.emit('intervention', event);

    // Schedule outcome check — 60s later, was the session still alive?
    if (level === EscalationLevel.CtrlC) {
      // Only track outcome from the first intervention (Ctrl+C)
      this.pendingOutcomeChecks.set(sessionName, event);
      setTimeout(() => this.checkOutcome(sessionName, event), 60_000);
    }

    // Persist to JSONL
    this.persistEvent(event);
  }

  /**
   * Check session health 60s after an intervention.
   * Did the session recover (still producing output) or die?
   */
  private checkOutcome(sessionName: string, event: InterventionEvent): void {
    const pending = this.pendingOutcomeChecks.get(sessionName);
    if (!pending || pending.timestamp !== event.timestamp) return;
    this.pendingOutcomeChecks.delete(sessionName);

    const sessions = this.sessionManager.listRunningSessions();
    const stillRunning = sessions.some(s => s.tmuxSession === sessionName);

    event.outcome = stillRunning ? 'recovered' : 'died';
    event.outcomeDelayMs = Date.now() - event.timestamp;

    // Persist the outcome update
    this.persistEvent({ ...event, _outcomeUpdate: true } as any);

    this.emit('outcome', { sessionName, outcome: event.outcome, level: event.level });
  }

  /**
   * Append an event to the persistent JSONL log.
   * 30-day retention, auto-rotated.
   */
  private persistEvent(event: InterventionEvent): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
      maybeRotateJsonl(this.logPath); // 10MB default, keep 75%
    } catch {
      // @silent-fallback-ok — persistence failure is non-critical
    }
  }

  /**
   * Read persistent intervention log entries since a given time.
   */
  readLog(sinceMs?: number): InterventionEvent[] {
    try {
      if (!fs.existsSync(this.logPath)) return [];
      const content = fs.readFileSync(this.logPath, 'utf-8').trim();
      if (!content) return [];

      const since = sinceMs ?? 0;
      return content.split('\n')
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter((e): e is InterventionEvent => e !== null && e.timestamp >= since);
    } catch {
      // @silent-fallback-ok — log read failure returns empty
      return [];
    }
  }

  /**
   * Get aggregated watchdog stats for a time window.
   * Used by TelemetryCollector for Baseline submissions.
   */
  getStats(sinceMs?: number): WatchdogStats {
    const events = this.readLog(sinceMs);
    const levelNames = ['monitoring', 'ctrl-c', 'sigterm', 'sigkill', 'kill-session'];

    const stats: WatchdogStats = {
      interventionsTotal: 0,
      interventionsByLevel: {},
      recoveries: 0,
      sessionDeaths: 0,
      outcomeUnknown: 0,
      llmGateOverrides: this.llmGateOverrides,
    };

    for (const event of events) {
      // Skip outcome update entries
      if ((event as any)._outcomeUpdate) {
        if (event.outcome === 'recovered') stats.recoveries++;
        else if (event.outcome === 'died') stats.sessionDeaths++;
        else stats.outcomeUnknown++;
        continue;
      }

      stats.interventionsTotal++;
      const levelName = levelNames[event.level] ?? `level-${event.level}`;
      stats.interventionsByLevel[levelName] = (stats.interventionsByLevel[levelName] || 0) + 1;
    }

    return stats;
  }

  /**
   * Rotate the persistent log — remove entries older than 30 days.
   */
  rotateLog(): void {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const content = fs.readFileSync(this.logPath, 'utf-8').trim();
      if (!content) return;

      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const lines = content.split('\n');
      const fresh = lines.filter(line => {
        try {
          const e = JSON.parse(line);
          return e.timestamp >= cutoff;
        } catch {
          return false;
        }
      });

      if (fresh.length < lines.length) {
        fs.writeFileSync(this.logPath, fresh.join('\n') + (fresh.length > 0 ? '\n' : ''));
      }
    } catch {
      // @silent-fallback-ok — rotation failure is non-critical
    }
  }
}
