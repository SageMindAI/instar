/**
 * `instar gate` CLI — operator tooling for the UnjustifiedStopGate
 * (context-death-pitfall-prevention spec § (d), PR4).
 *
 * Commands:
 *   instar gate status
 *   instar gate set unjustified-stop --mode <off|shadow|enforce>
 *   instar gate kill-switch --set
 *   instar gate kill-switch --clear
 *   instar gate log [--tail N]
 *
 * All commands hit the agent's local server over loopback with the
 * config.json bearer token. Multi-machine coordination (`--wait-sync`,
 * `--skip-machine`, `--allow-partial`) is deferred to PR4b — this MVP
 * flips the local machine only.
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

type GateMode = 'off' | 'shadow' | 'enforce';

function readConfig(stateDir: string): { port: number; authToken: string } {
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
  return {
    port: cfg.port ?? 4042,
    authToken: cfg.authToken ?? '',
  };
}

function resolveStateDir(opts: { dir?: string }): string {
  const projectDir = opts.dir ?? process.cwd();
  return path.join(projectDir, '.instar');
}

async function authedFetch(
  port: number,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

// ── `instar gate status` ─────────────────────────────────────────────

export async function gateStatus(opts: { dir?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts);
  const { port, authToken } = readConfig(stateDir);

  const [hotRes, killRes] = await Promise.all([
    authedFetch(port, authToken, '/internal/stop-gate/hot-path?session=status-probe'),
    authedFetch(port, authToken, '/internal/stop-gate/kill-switch'),
  ]);

  if (!hotRes.ok) {
    console.error(pc.red(`hot-path request failed: ${hotRes.status}`));
    process.exit(1);
  }
  if (!killRes.ok) {
    console.error(pc.red(`kill-switch request failed: ${killRes.status}`));
    process.exit(1);
  }

  const hot = (await hotRes.json()) as {
    mode: GateMode;
    killSwitch: boolean;
    autonomousActive: boolean;
    compactionInFlight: boolean;
    routeVersion: number;
  };
  const kill = (await killRes.json()) as { killSwitch: boolean };

  const modeColor = hot.mode === 'off' ? pc.gray : hot.mode === 'shadow' ? pc.yellow : pc.green;
  const killColor = kill.killSwitch ? pc.red : pc.gray;

  console.log(`${pc.bold('UnjustifiedStopGate — status')}`);
  console.log(`  Mode:              ${modeColor(hot.mode)}`);
  console.log(`  Kill-switch:       ${killColor(kill.killSwitch ? 'SET' : 'clear')}`);
  console.log(`  Autonomous active: ${hot.autonomousActive ? pc.cyan('yes') : pc.gray('no')}`);
  console.log(`  Compaction:        ${hot.compactionInFlight ? pc.yellow('in-flight') : pc.gray('idle')}`);
  console.log(`  Route version:     ${hot.routeVersion}`);
  console.log('');
  if (hot.mode === 'off') {
    console.log(pc.gray('  Gate is inert. Use `instar gate set unjustified-stop --mode shadow` to begin data collection.'));
  } else if (hot.mode === 'shadow') {
    console.log(pc.gray('  Shadow mode — observing only. No Stop events are blocked.'));
  } else if (hot.mode === 'enforce') {
    console.log(pc.gray('  Enforce mode — authority can emit `decision: block` with reminder.'));
  }
  if (kill.killSwitch) {
    console.log(pc.red('  Kill-switch is SET — every evaluation short-circuits to allow. Clear with --clear.'));
  }
}

// ── `instar gate set unjustified-stop --mode <mode>` ────────────────

export async function gateSet(
  subject: string,
  opts: { mode: string; dir?: string }
): Promise<void> {
  if (subject !== 'unjustified-stop') {
    console.error(pc.red(`unknown gate subject: ${subject} (supported: unjustified-stop)`));
    process.exit(1);
  }
  const mode = opts.mode;
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
    console.error(pc.red(`invalid --mode: ${mode} (must be off|shadow|enforce)`));
    process.exit(1);
  }

  const stateDir = resolveStateDir(opts);
  const { port, authToken } = readConfig(stateDir);

  const res = await authedFetch(port, authToken, '/internal/stop-gate/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(pc.red(`gate set failed: ${res.status} ${err}`));
    process.exit(1);
  }
  const body = (await res.json()) as { mode: GateMode; prior: GateMode; changed: boolean };
  if (body.changed) {
    console.log(
      pc.green(`✓ gate.unjustified-stop: mode ${pc.bold(body.prior)} → ${pc.bold(body.mode)}`)
    );
  } else {
    console.log(pc.gray(`gate.unjustified-stop already at mode=${body.mode}, no change`));
  }
  // Multi-machine note: MVP flips this machine only. PR4b adds the
  // --wait-sync / --skip-machine / --allow-partial fanout.
  console.log(
    pc.gray('  Note: this command flipped the local machine. Multi-machine fanout is PR4b.')
  );
}

// ── `instar gate kill-switch --set | --clear` ───────────────────────

export async function gateKillSwitch(opts: {
  set?: boolean;
  clear?: boolean;
  dir?: string;
}): Promise<void> {
  if (!opts.set && !opts.clear) {
    console.error(pc.red('--set or --clear required'));
    process.exit(1);
  }
  if (opts.set && opts.clear) {
    console.error(pc.red('--set and --clear are mutually exclusive'));
    process.exit(1);
  }
  const value = !!opts.set;

  const stateDir = resolveStateDir(opts);
  const { port, authToken } = readConfig(stateDir);

  const res = await authedFetch(port, authToken, '/internal/stop-gate/kill-switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(pc.red(`kill-switch failed: ${res.status} ${err}`));
    process.exit(1);
  }
  const body = (await res.json()) as { killSwitch: boolean; prior: boolean; changed: boolean };
  if (body.changed) {
    const arrow = body.killSwitch ? pc.red('SET') : pc.green('clear');
    console.log(`${pc.bold('Kill-switch')}: ${body.prior ? 'SET' : 'clear'} → ${arrow}`);
  } else {
    console.log(pc.gray(`Kill-switch already ${value ? 'SET' : 'clear'}, no change`));
  }
}

// ── `instar gate log [--tail N]` ────────────────────────────────────

export async function gateLog(opts: { tail?: string; dir?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts);
  const { port, authToken } = readConfig(stateDir);
  const tail = parseInt(opts.tail ?? '20', 10) || 20;

  const res = await authedFetch(port, authToken, `/internal/stop-gate/log?tail=${tail}`);
  if (!res.ok) {
    console.error(pc.red(`log request failed: ${res.status}`));
    process.exit(1);
  }
  const body = (await res.json()) as {
    events: Array<{
      eventId: string;
      ts: number;
      mode: string;
      decision: string | null;
      rule: string | null;
      invalidKind: string | null;
      reasonPreview: string;
      latencyMs: number;
    }>;
  };
  if (body.events.length === 0) {
    console.log(pc.gray('(no events yet)'));
    return;
  }
  for (const ev of body.events) {
    const when = new Date(ev.ts).toISOString().replace('T', ' ').slice(0, 19);
    const outcome = ev.invalidKind ? pc.yellow(`FAIL:${ev.invalidKind}`) : pc.green(ev.decision ?? 'n/a');
    const rule = ev.rule ? pc.cyan(ev.rule) : pc.gray('—');
    console.log(`${pc.gray(when)}  ${pc.gray(ev.mode)}  ${outcome.padEnd(16)}  ${rule}  ${ev.latencyMs}ms`);
    if (ev.reasonPreview) {
      console.log(pc.gray(`    ${ev.reasonPreview.slice(0, 120)}`));
    }
  }
}
