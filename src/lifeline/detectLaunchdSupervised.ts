/**
 * detectLaunchdSupervised — robust detection of "this process is supervised
 * by launchd / systemd / pid-1 init."
 *
 * Why this exists: the previous detection (`process.ppid === 1`) only catches
 * **system-domain** launchd. User agents installed via `launchctl bootstrap
 * gui/<uid>/...` are managed by the **per-user launchd**, whose pid is NOT 1.
 * On 2026-04-29 (Inspec post-mortem), that gap caused the RestartOrchestrator
 * to refuse to exit-for-self-heal because it thought the lifeline was running
 * unsupervised, even though launchd was right there ready to respawn it.
 *
 * Detection signals (any one is sufficient):
 *   1. INSTAR_SUPERVISED=1 set explicitly.
 *   2. process.ppid === 1 (system-domain launchd / Linux init).
 *   3. macOS: parent process command name is exactly `launchd` (catches user-launchd).
 *   4. Linux: parent process command name is exactly `systemd` or `init`.
 *
 * Cached after first call — supervision parentage doesn't change at runtime.
 *
 * NODE_ENV === 'test' short-circuits to false so unit tests don't accidentally
 * pass the gate just because they were spawned from a launchd-managed shell.
 */

import { spawnSync } from 'node:child_process';

let _cached: boolean | null = null;

export interface DetectOptions {
  /** Override platform — for testing. */
  platform?: NodeJS.Platform;
  /** Override env — for testing. */
  env?: NodeJS.ProcessEnv;
  /** Override ppid — for testing. */
  ppid?: number;
  /**
   * Override the parent-process-name lookup — for testing. Receives ppid,
   * returns the parent command name (or null if not resolvable).
   */
  parentNameLookup?: (ppid: number) => string | null;
}

/**
 * Look up the parent process command name. macOS / Linux only — returns null
 * on other platforms. Uses `ps -p <ppid> -o comm=` which is portable and
 * doesn't require parsing /proc.
 */
function defaultParentNameLookup(ppid: number): string | null {
  try {
    const result = spawnSync('ps', ['-p', String(ppid), '-o', 'comm='], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (result.status !== 0) return null;
    const name = (result.stdout || '').trim();
    if (!name) return null;
    // ps may return a path on macOS (e.g., "/sbin/launchd"); take basename.
    const slash = name.lastIndexOf('/');
    return slash >= 0 ? name.slice(slash + 1) : name;
  } catch {
    return null;
  }
}

/**
 * Detect whether this process is supervised by an init/launchd-class process
 * that will respawn it after exit. Cached.
 */
export function detectLaunchdSupervised(opts: DetectOptions = {}): boolean {
  // Tests pass explicit opts; bypass the cache so each test sees a fresh result.
  // Note: any provided value (including `env: {}`) counts as an explicit test
  // call — empty objects are truthy, so a test that passes `env: {}` and any
  // other option will correctly bypass the runtime cache.
  const isExplicitTestCall = opts.platform || opts.env || opts.ppid !== undefined || opts.parentNameLookup;
  if (!isExplicitTestCall && _cached !== null) return _cached;

  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const ppid = opts.ppid ?? process.ppid;
  const parentNameLookup = opts.parentNameLookup ?? defaultParentNameLookup;

  const result = (() => {
    // Test environments must not be treated as supervised — even if the test
    // runner happens to have ppid=1 or was spawned from launchd. The whole
    // point of unsupervised mode is "don't actually exit during tests."
    if (env.NODE_ENV === 'test') {
      // INSTAR_SUPERVISED=1 is the explicit override that lets specific tests
      // exercise the supervised path on purpose.
      return env.INSTAR_SUPERVISED === '1';
    }

    // Signal 1: explicit env var.
    if (env.INSTAR_SUPERVISED === '1') return true;

    // Signal 2: classic init-as-parent. Catches system-domain launchd on macOS,
    // pid-1 init on Linux, BSD init.
    if (ppid === 1) return true;

    // Signal 3 (darwin): parent is the user-launchd process. ppid won't be 1
    // for user-domain agents — it'll be whatever pid the user's launchd has.
    // The reliable signal is the parent command name.
    if (platform === 'darwin') {
      const parentName = parentNameLookup(ppid);
      if (parentName === 'launchd') return true;
    }

    // Signal 4 (linux): systemd-managed services have a per-user systemd as
    // parent (or the system systemd at pid 1, already caught above).
    if (platform === 'linux') {
      const parentName = parentNameLookup(ppid);
      if (parentName === 'systemd' || parentName === 'init') return true;
    }

    return false;
  })();

  if (!isExplicitTestCall) _cached = result;
  return result;
}

/** Reset the cached detection — for tests only. */
export function _resetSupervisionCacheForTesting(): void {
  _cached = null;
}
