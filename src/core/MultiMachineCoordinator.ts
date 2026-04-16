/**
 * Multi-machine coordinator — orchestrates distributed agent lifecycle.
 *
 * Brings together HeartbeatManager, MachineIdentityManager, SecurityLog,
 * and NonceStore into a single coordinator that the server lifecycle uses.
 *
 * Responsibilities:
 * - Determine this machine's role on startup (awake/standby)
 * - Periodic heartbeat writes (awake) / monitoring (standby)
 * - Auto-failover when the awake machine goes silent
 * - StateManager read-only enforcement on standby
 * - Graceful shutdown handoff attempt
 *
 * Part of Phase 5 (distributed coordination).
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { MachineIdentityManager } from './MachineIdentity.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { SecurityLog } from './SecurityLog.js';
import { NonceStore } from './NonceStore.js';
import type { StateManager } from './StateManager.js';
import type { MachineRole, MachineIdentity, MultiMachineConfig, CoordinationMode } from './types.js';

// ── Constants ────────────────────────────────────────────────────────

const HEARTBEAT_WRITE_INTERVAL_MS = 2 * 60_000; // Write heartbeat every 2 min
const HEARTBEAT_CHECK_INTERVAL_MS = 2 * 60_000;  // Check heartbeat every 2 min
const DEFAULT_FAILOVER_TIMEOUT_MS = 15 * 60_000;  // 15 min before failover

// ── Types ────────────────────────────────────────────────────────────

export interface CoordinatorConfig {
  /** State directory (.instar) */
  stateDir: string;
  /** Multi-machine config from config.json */
  multiMachine?: MultiMachineConfig;
}

export interface CoordinatorEvents {
  /** Emitted when this machine should promote to awake */
  promote: () => void;
  /** Emitted when this machine should demote to standby */
  demote: () => void;
  /** Emitted when auto-failover triggers */
  failover: (reason: string) => void;
  /** Emitted on role change */
  roleChange: (from: MachineRole, to: MachineRole) => void;
}

// ── Coordinator ──────────────────────────────────────────────────────

export class MultiMachineCoordinator extends EventEmitter {
  private identityManager: MachineIdentityManager;
  private heartbeatManager: HeartbeatManager;
  private securityLog: SecurityLog;
  private nonceStore: NonceStore;
  private state: StateManager;
  private config: CoordinatorConfig;
  private _role: MachineRole = 'standby';
  private _identity: MachineIdentity | null = null;
  private _enabled: boolean = false;
  private heartbeatWriteTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Integrated-Being v1 — tracks whether we've already emitted the
   *  per-machine-ledger warning this boot. Spec §Multi-machine. */
  private integratedBeingWarningEmitted: boolean = false;

  constructor(state: StateManager, config: CoordinatorConfig) {
    super();
    this.state = state;
    this.config = config;
    this.identityManager = new MachineIdentityManager(config.stateDir);
    this.securityLog = new SecurityLog(config.stateDir);
    this.nonceStore = new NonceStore(path.join(config.stateDir, 'state'));

    // HeartbeatManager gets created once we know our machine ID
    this.heartbeatManager = null as any; // Initialized in start()
  }

  // ── Getters ──────────────────────────────────────────────────────

  /** Whether multi-machine is enabled (has identity). */
  get enabled(): boolean { return this._enabled; }

  /** This machine's current role. */
  get role(): MachineRole { return this._role; }

  /** This machine's identity (null if not initialized). */
  get identity(): MachineIdentity | null { return this._identity; }

  /** Whether this machine is the awake (primary) machine. */
  get isAwake(): boolean { return this._role === 'awake'; }

  /** The coordination mode (default: 'primary-standby'). */
  get coordinationMode(): CoordinationMode {
    return this.config.multiMachine?.coordinationMode ?? 'primary-standby';
  }

  /** The underlying managers (for route wiring). */
  get managers() {
    return {
      identityManager: this.identityManager,
      heartbeatManager: this.heartbeatManager,
      securityLog: this.securityLog,
      nonceStore: this.nonceStore,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Initialize and start the coordinator.
   * Returns the determined role for this machine.
   */
  start(): MachineRole {
    // Check if multi-machine is set up
    if (!this.identityManager.hasIdentity()) {
      this._enabled = false;
      this._role = 'awake'; // Single machine = always awake
      return this._role;
    }

    this._enabled = true;
    this._identity = this.identityManager.loadIdentity();

    // Self-heal: if the registry is missing our own machine, re-register it
    // before any updateRole call. Without this, a registry wiped by a sync
    // corruption, disk glitch, or manual cleanup hard-crashes the server
    // on boot because updateRole throws on unknown machineIds.
    this.identityManager.ensureSelfRegistered(this._identity, 'standby');

    // Integrated-Being v1 — per-machine ledger warning.
    // Emit exactly once per startup when the registry shows >1 machine.
    // The ledger itself is per-machine and does NOT sync cross-machine (see
    // .gitignore entry for shared-state.jsonl*).
    this.emitIntegratedBeingMultiMachineWarning();

    this.securityLog.initialize();

    // Create HeartbeatManager with our machine ID
    const timeoutMs = (this.config.multiMachine?.failoverTimeoutMinutes ?? 15) * 60_000;
    const autoFailover = this.config.multiMachine?.autoFailover ?? true;
    this.heartbeatManager = new HeartbeatManager(this.config.stateDir, this._identity.machineId, {
      enabled: autoFailover,
      timeoutMs,
    });

    const mode = this.coordinationMode;

    // ── Independent Mode (Gap 1) ─────────────────────────────────
    // Both machines are always awake. No failover, no demotion.
    // Each machine has its own Telegram group — no polling conflict.
    if (mode === 'independent') {
      this._role = 'awake';
      this.identityManager.updateRole(this._identity.machineId, 'awake');
      this.startHeartbeatWriter(); // For diagnostics, not failover
      // Do NOT start heartbeat monitor (no failover logic in independent mode)

      this.securityLog.append({
        event: 'coordinator_started',
        machineId: this._identity.machineId,
        role: this._role,
        coordinationMode: 'independent',
      });

      console.log(`[MultiMachine] Independent mode — machine ${this._identity.machineId} always awake`);
      return this._role;
    }

    // ── Primary-Standby Mode (default) ───────────────────────────
    // Determine initial role from registry
    const registry = this.identityManager.loadRegistry();
    const myEntry = registry.machines[this._identity.machineId];
    this._role = myEntry?.role ?? 'standby';

    // Check the heartbeat to validate our role
    const heartbeatCheck = this.heartbeatManager.checkHeartbeat();

    if (this._role === 'awake') {
      // We think we're awake — verify no one else took over
      if (heartbeatCheck.status === 'healthy' && heartbeatCheck.holder !== this._identity.machineId) {
        // Another machine has a valid heartbeat — demote
        console.log(`[MultiMachine] Another machine (${heartbeatCheck.holder}) has valid heartbeat — demoting to standby`);
        this._role = 'standby';
        this.identityManager.updateRole(this._identity.machineId, 'standby');
      } else {
        // We're the rightful awake machine — start heartbeat writes
        this.startHeartbeatWriter();
      }
    } else {
      // We're standby — check if we should failover
      if (heartbeatCheck.status === 'expired' || heartbeatCheck.status === 'missing') {
        const failoverResult = this.heartbeatManager.shouldFailover();
        if (failoverResult.should) {
          console.log(`[MultiMachine] Failover condition: ${failoverResult.reason}`);
          this.promoteToAwake(`Startup failover: ${failoverResult.reason}`);
        }
      }
    }

    // Set StateManager read-only for standby
    if (this._role === 'standby') {
      this.state.setReadOnly(true);
    }

    // Start the heartbeat monitor (checks periodically regardless of role)
    this.startHeartbeatMonitor();

    this.securityLog.append({
      event: 'coordinator_started',
      machineId: this._identity.machineId,
      role: this._role,
    });

    return this._role;
  }

  /**
   * Stop the coordinator. Call on server shutdown.
   */
  /**
   * Integrated-Being v1 — log a one-time warning when paired on >1 machine.
   * Spec §Multi-machine. The ledger is per-machine; cross-machine coherence
   * is out of scope for v1.
   */
  private emitIntegratedBeingMultiMachineWarning(): void {
    if (this.integratedBeingWarningEmitted) return;
    try {
      const registry = this.identityManager.loadRegistry();
      const count = Object.keys(registry.machines ?? {}).length;
      if (count > 1) {
        console.warn(
          `[integrated-being] This agent runs on ${count} machines. ` +
          `Each machine has its own ledger; cross-machine visibility is not yet implemented.`,
        );
        this.integratedBeingWarningEmitted = true;
      }
    } catch {
      // Don't fail startup on warning-emission failure.
    }
  }

  stop(): void {
    if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
      this.heartbeatWriteTimer = null;
    }
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }
    this.nonceStore.destroy();
  }

  // ── Role Transitions ─────────────────────────────────────────────

  /**
   * Promote this machine to awake.
   * Called on failover or explicit wakeup.
   */
  promoteToAwake(reason: string): void {
    if (!this._identity) return;
    const oldRole = this._role;
    this._role = 'awake';

    // Update registry
    this.identityManager.updateRole(this._identity.machineId, 'awake');

    // Write initial heartbeat
    this.heartbeatManager.writeHeartbeat();

    // Start heartbeat writer
    this.startHeartbeatWriter();

    // Enable writes on StateManager
    this.state.setReadOnly(false);

    this.securityLog.append({
      event: 'role_transition',
      machineId: this._identity.machineId,
      from: oldRole,
      to: 'awake',
      reason,
    });

    this.emit('promote');
    this.emit('roleChange', oldRole, 'awake');
    console.log(`[MultiMachine] Promoted to awake: ${reason}`);
  }

  /**
   * Demote this machine to standby.
   * Called when another machine takes over.
   */
  demoteToStandby(reason: string): void {
    if (!this._identity) return;
    const oldRole = this._role;
    this._role = 'standby';

    // Update registry
    this.identityManager.updateRole(this._identity.machineId, 'standby');

    // Stop heartbeat writer
    if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
      this.heartbeatWriteTimer = null;
    }

    // Set StateManager read-only
    this.state.setReadOnly(true);

    this.securityLog.append({
      event: 'role_transition',
      machineId: this._identity.machineId,
      from: oldRole,
      to: 'standby',
      reason,
    });

    this.emit('demote');
    this.emit('roleChange', oldRole, 'standby');
    console.log(`[MultiMachine] Demoted to standby: ${reason}`);
  }

  // ── Heartbeat Hot-Path ───────────────────────────────────────────

  /**
   * The hot-path check that runs before every Telegram poll.
   * Returns true if this machine should NOT process messages.
   */
  shouldSkipProcessing(): boolean {
    if (!this._enabled) return false; // Single machine = always process
    // Independent mode: both machines always process
    if (this.coordinationMode === 'independent') return false;
    if (this._role !== 'awake') return true; // Standby = skip

    // Even if we think we're awake, check the heartbeat file
    return this.heartbeatManager.shouldDemote();
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Start periodic heartbeat writes (awake machine only).
   */
  private startHeartbeatWriter(): void {
    if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
    }

    // Write immediately
    this.heartbeatManager.writeHeartbeat();

    // Then every 2 minutes
    this.heartbeatWriteTimer = setInterval(() => {
      if (this._role === 'awake') {
        this.heartbeatManager.writeHeartbeat();
        // Touch lastSeen in registry
        if (this._identity) {
          try {
            this.identityManager.touchMachine(this._identity.machineId);
          } catch {
            // @silent-fallback-ok — lastSeen update non-critical
          }
        }
      }
    }, HEARTBEAT_WRITE_INTERVAL_MS);

    if (this.heartbeatWriteTimer.unref) {
      this.heartbeatWriteTimer.unref();
    }
  }

  /**
   * Start periodic heartbeat monitoring (all machines).
   */
  private startHeartbeatMonitor(): void {
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
    }

    this.heartbeatCheckTimer = setInterval(() => {
      this.checkHeartbeatAndAct();
    }, HEARTBEAT_CHECK_INTERVAL_MS);

    if (this.heartbeatCheckTimer.unref) {
      this.heartbeatCheckTimer.unref();
    }
  }

  /**
   * Check the heartbeat and take action if needed.
   */
  private checkHeartbeatAndAct(): void {
    if (!this._identity) return;
    // Independent mode: no failover/demotion logic
    if (this.coordinationMode === 'independent') return;

    if (this._role === 'awake') {
      // Awake machine: check if someone else took over
      if (this.heartbeatManager.shouldDemote()) {
        this.demoteToStandby('Another machine has a valid heartbeat');
      }
    } else {
      // Standby machine: check for failover condition
      const failoverResult = this.heartbeatManager.shouldFailover();
      if (failoverResult.should) {
        this.heartbeatManager.recordFailover();
        this.promoteToAwake(`Auto-failover: ${failoverResult.reason}`);
        this.emit('failover', failoverResult.reason);
      }
    }
  }
}
